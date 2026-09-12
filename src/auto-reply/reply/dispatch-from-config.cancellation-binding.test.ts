// The followup queue installs its durable cancellation write on whichever
// turnAdoptionLifecycle object the queued run carries, while the Gateway keeps
// invoking the lifecycle it created. gatherDispatchRequest copies that object to
// observe adoption, so cancellation custody must stay aliased to the owner —
// otherwise `chat.abort` acknowledges a cancel that never wrote its tombstone
// and the retained row executes after a restart.
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { TurnAdoptionLifecycle } from "../get-reply-options.types.js";
import { gatherDispatchRequest } from "./dispatch-from-config.gather.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";

let state: OpenClawTestState | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await state?.cleanup();
});

it("keeps cancellation custody on the lifecycle owner across the dispatch copy", async () => {
  state = await createOpenClawTestState({ label: "dispatch-cancellation-binding" });
  const cfg: OpenClawConfig = {
    agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
    plugins: { enabled: false },
    session: { scope: "global" },
  };
  await state.writeConfig(cfg);

  const owner: TurnAdoptionLifecycle = {
    admission: "cancel-only",
    onAdopted: async () => {},
  };
  const dispatcher = createReplyDispatcher({ deliver: async () => undefined });
  try {
    const gathered = await gatherDispatchRequest(
      {
        cfg,
        ctx: {
          AgentId: "main",
          SessionKey: "global",
          Body: "hello",
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
          CommandAuthorized: false,
        },
        dispatcher,
        replyOptions: { turnAdoptionLifecycle: owner },
      },
      undefined,
    );
    expect(gathered.status).toBe("ready");
    if (gathered.status !== "ready") {
      throw new Error("dispatch gather did not prepare the turn");
    }

    const dispatched = gathered.state.getReplyOptions()?.turnAdoptionLifecycle;
    if (!dispatched) {
      throw new Error("dispatch gather dropped the turn adoption lifecycle");
    }
    // Adoption is still observed through a copy, not the owner itself.
    expect(dispatched).not.toBe(owner);

    // Stand in for enqueue's bindDurableCancellation, which installs on the copy.
    const persistCancellation = () => {};
    dispatched.onCancellationRequested = persistCancellation;

    // The Gateway closure reads the original; it must see the queue's write.
    expect(owner.onCancellationRequested).toBe(persistCancellation);
    expect(dispatched.onCancellationRequested).toBe(persistCancellation);
  } finally {
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
  }
});
