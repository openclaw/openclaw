// New join requests prompt the owner once in this browser; the decision stays on Access → People,
// where this browser's owner device signs it.
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { createSignal, Show } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";
import { registerOpenClawIdEnglish } from "../../i18n/locales/en-openclaw-id.ts";
import { openClawIdFeatureSignal } from "../../lib/openclaw-id/feature-lifetime.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { withPromiseModalHost } from "../promise-modal-host.ts";
import type { SidebarInboxEntry, SidebarAttentionItem } from "../sidebar-attention-entries.ts";

registerEnglishCatalog(registerOpenClawIdEnglish);

type JoinRequest = SidebarAttentionItem & { kind: "openClawIdRequest" };
type PromptOutcome = "later" | "review" | "closed";

function joinRequests(entries: readonly SidebarInboxEntry[]): JoinRequest[] {
  return entries.filter(
    (entry): entry is JoinRequest =>
      entry.type === "attention" && entry.kind === "openClawIdRequest",
  );
}

// Requests already shown, per Gateway and profile. A loopback operator may have no profile
// (selfUser null); wait only while the profile is still loading.
function promptedKey(gateway: ApplicationContext["gateway"]): string | null {
  const { phase, selfUser } = gateway.snapshot;
  const url = gateway.connection.gatewayUrl;
  return phase === "connected" && url && selfUser !== undefined
    ? `openclaw.control.openclawIdJoinPrompts.v1:${JSON.stringify([gatewayCredentialScope(url), selfUser?.id ?? null])}`
    : null;
}

function loadPrompted(key: string | null): string[] {
  try {
    const value: unknown = key ? JSON.parse(getSafeLocalStorage()?.getItem(key) ?? "[]") : [];
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function savePrompted(key: string | null, signatures: readonly string[]): void {
  try {
    if (key && signatures.length) {
      getSafeLocalStorage()?.setItem(key, JSON.stringify(signatures));
    } else if (key) {
      getSafeLocalStorage()?.removeItem(key);
    }
  } catch {
    // Without storage the prompt returns on the next load; the Inbox row is unaffected.
  }
}

function showJoinRequestPrompt(initial: readonly JoinRequest[]): {
  update: (requests: readonly JoinRequest[]) => void;
  close: () => void;
  outcome: Promise<PromptOutcome>;
} {
  const [requests, setRequests] = createSignal<readonly JoinRequest[]>(initial);
  let finish: ((outcome: PromptOutcome) => void) | undefined;
  const outcome = withPromiseModalHost<PromptOutcome>(
    { signal: openClawIdFeatureSignal(), value: "closed" },
    (modal) => {
      finish = modal.finish;
      const newest = () => requests()[0]!;
      modal.render(() => (
        <openclaw-modal-dialog
          label={newest().label}
          description={newest().meta?.status ?? ""}
          onModal-cancel={() => modal.finish("later")}
        >
          <div class="exec-approval-modal-stack">
            <div class="exec-approval-card exec-approval-card--modal exec-approval-card--severity-warning">
              <div class="exec-approval-modal-content">
                <div class="exec-approval-header">
                  <div class="exec-approval-heading">
                    <div class="exec-approval-title" title={newest().label}>
                      {newest().label}
                    </div>
                    <div class="exec-approval-sub">{newest().meta?.status}</div>
                  </div>
                  <Show when={requests().length > 1}>
                    <div class="exec-approval-queue">
                      {t("openclawId.joinRequestMore", { count: String(requests().length - 1) })}
                    </div>
                  </Show>
                </div>
                <p class="exec-approval-sub">{newest().detail}</p>
              </div>
              <openclaw-modal-actions class="exec-approval-actions">
                <button type="button" class="btn" onClick={() => modal.finish("later")}>
                  {t("openclawId.joinRequestLater")}
                </button>
                <button type="button" class="btn primary" onClick={() => modal.finish("review")}>
                  {t("openclawId.joinRequestReview")}
                </button>
              </openclaw-modal-actions>
            </div>
          </div>
        </openclaw-modal-dialog>
      ));
    },
  );
  return {
    update: (next) => setRequests(next),
    close: () => finish?.("closed"),
    outcome,
  };
}

/**
 * Pops up once for each new owner join request in the Inbox. Later or Review keeps the
 * shown requests quiet until another arrives; a decided or expired request closes it.
 */
export function bindJoinRequestPrompt(
  context: Pick<ApplicationContext, "gateway" | "sidebarAttention" | "navigate">,
): () => void {
  // Covers a profile whose prompts cannot be stored, keyed like the stored prompts.
  const shown = new Set<string>();
  let disposed = false;
  let prompt: {
    key: string;
    requests: readonly JoinRequest[];
    view: ReturnType<typeof showJoinRequestPrompt>;
  } | null = null;
  const sync = () => {
    const key = promptedKey(context.gateway);
    if (prompt && prompt.key !== key) {
      prompt.view.close();
      return;
    }
    const requests = key ? joinRequests(context.sidebarAttention.entries) : [];
    const current = requests.map((request) => request.signature);
    const stored = loadPrompted(key);
    const kept = stored.filter((signature) => current.includes(signature));
    // An empty Inbox may still be loading; prune only against a listed set.
    if (current.length > 0 && kept.length !== stored.length) {
      savePrompted(key, kept);
    }
    // The prompt shows only requests this profile has not been shown; the Inbox lists them all.
    const fresh = requests.filter(
      (request) => !kept.includes(request.signature) && !shown.has(`${key}\n${request.signature}`),
    );
    if (prompt) {
      if (fresh.length === 0) {
        prompt.view.close();
      } else {
        prompt.requests = fresh;
        prompt.view.update(fresh);
      }
      return;
    }
    if (!key || fresh.length === 0) {
      return;
    }
    const opened = { key, requests: fresh, view: showJoinRequestPrompt(fresh) };
    prompt = opened;
    void opened.view.outcome.then((outcome) => {
      if (prompt === opened) {
        prompt = null;
      }
      if (disposed) {
        return;
      }
      if (outcome === "closed") {
        // A changed profile may still have requests it has not been shown.
        sync();
        return;
      }
      const signatures = opened.requests.map((request) => request.signature);
      signatures.forEach((signature) => shown.add(`${opened.key}\n${signature}`));
      savePrompted(opened.key, [...new Set([...loadPrompted(opened.key), ...signatures])]);
      const action = opened.requests[0]?.action;
      if (outcome === "review" && action?.kind === "navigate") {
        context.navigate(action.routeId, action.search ? { search: action.search } : undefined);
      }
    });
  };
  const stops = [context.sidebarAttention.subscribe(sync), context.gateway.subscribe(sync)];
  sync();
  return () => {
    disposed = true;
    stops.forEach((stop) => stop());
    prompt?.view.close();
  };
}
