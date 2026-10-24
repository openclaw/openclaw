import { expectDefined } from "@openclaw/normalization-core";
import { createMemo, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { TerminalGatewayClient } from "../../components/terminal/terminal-connection.ts";
import { terminalOpenResult } from "../../components/terminal/terminal-panel.test-support.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { createSubmissionAction, type SubmissionPresentation } from "./submission-action.ts";

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

it("releases retired native startup presentation before its owner receives the late PTY", async () => {
  const starting = Promise.withResolvers<ReturnType<typeof terminalOpenResult>>();
  const closing = Promise.withResolvers<void>();
  const { flow, context, request, changed } = createDraftFixture({
    scopes: ["operator.admin"],
    methods: ["sessions.catalog.startTerminal", "terminal.open"],
    data: {
      agentId: "main",
      requestedAgentId: "main",
      catalogId: "codex",
      catalogLabel: "Codex",
      startTerminal: true,
      terminalHosts: [{ hostId: "gateway:local", label: "Local" }],
    },
    request: async (method) => {
      if (method === "sessions.catalog.startTerminal") {
        return starting.promise;
      }
      if (method === "terminal.close") {
        return closing.promise;
      }
      return {};
    },
  });
  const client = expectDefined(context.gateway.snapshot.client, "connected Gateway");
  Object.assign(client, {
    addEventListener: vi.fn<TerminalGatewayClient["addEventListener"]>(() => () => {}),
    forceReconnect: vi.fn(),
  });
  let lifetime = Promise.withResolvers<void>();
  const owner: SubmissionPresentation = {
    get submissionLifetime() {
      return lifetime.promise;
    },
  };
  let operationFinished = false;
  const view = mountSolid(() => {
    const [revision, publish] = createSignal(0);
    changed.mockImplementation(() => publish((value) => value + 1));
    const outcome = createMemo(() => {
      revision();
      return flow.error;
    });
    const saving = createSubmissionAction(
      () => owner,
      revision,
      outcome,
      (error) => {
        flow.setError(String(error));
      },
    );
    return <p role="status">{saving() ? "Starting native terminal" : "Ready"}</p>;
  });
  await waitForSolid(() => expect(owner.presentSubmit).toBeTypeOf("function"));
  flow.setMessage("Keep this unsent draft");
  expect(flow.submitBlock()).toBeUndefined();
  const presenting = owner.presentSubmit!(async () => {
    await flow.submit();
    operationFinished = true;
  });
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "sessions.catalog.startTerminal",
      expect.objectContaining({ initialMessage: "Keep this unsent draft" }),
      { timeoutMs: 35_000 },
    ),
  );
  await waitForSolid(() =>
    expect(view.getByRole("status").textContent).toBe("Starting native terminal"),
  );

  flow.invalidate("gateway-changed");
  lifetime.resolve();
  lifetime = Promise.withResolvers<void>();
  changed();
  await waitForSolid(() => expect(view.getByRole("status").textContent).toBe("Ready"));
  expect(operationFinished).toBe(false);
  starting.resolve(terminalOpenResult("late-native-start"));
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("terminal.close", { sessionId: "late-native-start" }),
  );
  await presenting;
  expect(operationFinished).toBe(true);
  closing.resolve();
  expect(flow.message).toBe("Keep this unsent draft");
  expect(context.replace).not.toHaveBeenCalled();
  expect(context.sessions.createResult).not.toHaveBeenCalled();
});
