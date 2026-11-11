import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { SessionCreateParams } from "../../lib/sessions/create.ts";
import { generateUUID } from "../../lib/uuid.ts";

type PendingCreate = Parameters<ApplicationContext["chatSubmissions"]["beginBackgroundCreate"]>[0];
type Preview = {
  creation: { sessionKey: string; admitted: boolean };
  entry: PendingCreate;
  handle: ReturnType<ApplicationContext["chatSubmissions"]["beginBackgroundCreate"]>;
  retry: () => void;
};

/**
 * Optimistic route preview for one draft's background start. The session key is
 * chosen before sending so its route shows the prompt while the Gateway prepares it;
 * Try again keeps that key, so an open route follows the same start.
 */
export class BackgroundCreatePreview {
  private preview: Preview | undefined;

  begin(options: {
    context: ApplicationContext;
    agentId: string;
    params: SessionCreateParams;
    resumed: boolean;
    message: PendingCreate["message"];
    displayName?: string;
    retry: () => void;
  }) {
    const { context, params } = options;
    // A resumed request keeps its frozen key; an unkeyed resume has no preview.
    const key =
      params.key ??
      (options.resumed
        ? undefined
        : (this.preview?.creation.sessionKey ??
          `agent:${options.agentId}:dashboard:${params.incognito ? "incognito-" : ""}${generateUUID()}`));
    if (!key) {
      this.clear();
      return;
    }
    if (!options.resumed) {
      params.key = key;
    }
    const scope = gatewayPresentationScope(context.gateway);
    const gatewayUrl = context.gateway.connection.gatewayUrl;
    const current = this.preview?.creation.sessionKey === key ? this.preview : undefined;
    const creation = current?.creation ?? { sessionKey: key, admitted: false };
    const entry: PendingCreate = {
      creation,
      message: options.message,
      displayName: options.displayName,
      canDisplay: () =>
        gatewayPresentationScope(context.gateway) === scope &&
        context.gateway.connection.gatewayUrl === gatewayUrl,
    };
    if (current) {
      current.handle.update(entry);
      this.preview = { ...current, entry, retry: options.retry };
    } else {
      this.clear();
      const handle = context.chatSubmissions.beginBackgroundCreate(entry);
      this.preview = { creation, entry, handle, retry: options.retry };
    }
  }

  /**
   * Completion runs after the accepted first turn is retained for display, so the
   * route can mount the real conversation without an empty frame.
   */
  admitBefore(complete: (key: string, runId?: string) => boolean) {
    return (key: string, runId?: string) => {
      this.clear();
      return complete(key, runId);
    };
  }

  /** A failed start keeps its preview and key for Try again; any other end retires it. */
  settle(error: string | null, pending: boolean) {
    const preview = this.preview;
    if (!preview || pending) {
      return;
    }
    if (!error) {
      this.clear();
      return;
    }
    preview.entry = { ...preview.entry, failure: { error, retry: preview.retry } };
    preview.handle.update(preview.entry);
  }

  clear() {
    const preview = this.preview;
    this.preview = undefined;
    if (preview) {
      // Retiring the preview hands its route to the real conversation owner.
      preview.creation.admitted = true;
      preview.handle.clear();
    }
  }
}
