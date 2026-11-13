import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { isTarget, routeKey } from "./catalog-target.ts";
import type { DraftPlaceState } from "./draft-place-state.ts";
import type { DraftSubmissionFlow } from "./draft-submission-flow.ts";
import type { NewSessionRouteData } from "./location.ts";

type DraftTitleInput = {
  client: Pick<GatewayBrowserClient, "request">;
  agentId: string;
  ownerKey?: string;
  message: string;
  model?: string;
};

function sameDraft(left: DraftTitleInput | null, right: DraftTitleInput | null): boolean {
  return (
    left?.client === right?.client &&
    left?.agentId === right?.agentId &&
    left?.ownerKey === right?.ownerKey &&
    left?.message === right?.message &&
    left?.model === right?.model
  );
}

/** Owns disposable title work for New Session, never the chat route. */
export function createNewSessionTitle(
  read: () => {
    context: ApplicationContext | undefined;
    data: NewSessionRouteData | undefined;
    place: DraftPlaceState;
    submission: DraftSubmissionFlow;
    dictating: boolean;
  },
) {
  let current: DraftTitleInput | null = null;
  let title: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let pending = false;
  let readyAt = 0;
  let disposed = false;
  let composing = false;
  let submitted: DraftTitleInput | null = null;

  return {
    dispose() {
      disposed = true;
      sync(null);
      submitted = null;
    },
    synchronize: () => sync(readInput()),
    setComposing(value: boolean) {
      composing = value;
      sync(readInput());
    },
    takePreparedTitle(): string | undefined {
      const next = readInput();
      const prepared = sameDraft(current, next) ? (title ?? undefined) : undefined;
      submitted = next ?? submitted;
      sync(null);
      return prepared;
    },
  };

  function sync(input: DraftTitleInput | null) {
    const next =
      input && input.message.length >= 12 && !input.message.startsWith("/") ? input : null;
    if (sameDraft(current, next)) {
      return;
    }
    clearTimeout(timer);
    current = next;
    title = null;
    pending = next !== null;
    readyAt = Date.now() + 1_000;
    schedule();
  }

  function schedule() {
    if (!pending || active) {
      return;
    }
    timer = setTimeout(() => void prepare(), Math.max(0, readyAt - Date.now()));
  }

  async function prepare() {
    const preparing = current;
    if (!preparing || !pending) {
      return;
    }
    pending = false;
    active = true;
    try {
      const result = await preparing.client.request<{ title: string | null }>(
        "sessions.title.prepare",
        {
          agentId: preparing.agentId,
          message: truncateUtf16Safe(preparing.message, 1_000),
          ...(preparing.model ? { model: preparing.model } : {}),
        },
        { timeoutMs: 20_000 },
      );
      // Object identity fences edits, route changes, privacy changes, and teardown,
      // including a draft that changes away and then back during the request.
      if (current === preparing) {
        title = result.title;
      }
    } catch {
      // Speculation must never block Send or leak a provider error into the draft.
      // An unchanged failed draft is not retried until the operator edits it.
    } finally {
      active = false;
      schedule();
    }
  }

  function readInput(): DraftTitleInput | null {
    const { context, data, place, submission, dictating } = read();
    const snapshot = context?.gateway.snapshot;
    // Native prompts belong to the selected CLI, never OpenClaw title inference.
    if (
      disposed ||
      isTarget(data) ||
      composing ||
      dictating ||
      submission.submitting ||
      submission.visibility === "incognito" ||
      submission.pendingPlacement.sessionKey ||
      !place.agentId ||
      !place.modelControl.accountSelectionReady() ||
      !canCallGatewayMethod(snapshot, "sessions.title.prepare", "operator.write") ||
      !snapshot?.client
    ) {
      return null;
    }
    const input = {
      client: snapshot.client,
      ownerKey: routeKey(data),
      agentId: place.agentId,
      message: submission.message.trim(),
      model: place.modelControl.modelForSubmission(),
    };
    // A failed navigation/retry may leave this page mounted after creation. The
    // submitted draft cannot start more inference; only a new draft can do so.
    return sameDraft(input, submitted) ? null : input;
  }
}
