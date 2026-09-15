import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as secretRegistry from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createNodeWorkerSupervisorFixture,
  waitForNodeWorkerTerminal as waitForTerminal,
} from "./node-worker-supervisor.fixture.test-support.js";
import type { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_CREDENTIAL,
  TEST_WORKER_ENDPOINT,
  testNodeWorkerLaunchIdentity,
  testWorkerLaunchInput,
} from "./node-worker-supervisor.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
  closeOpenClawStateDatabaseForTest();
});

function fixture(options: Parameters<typeof createNodeWorkerSupervisor>[0] = {}) {
  return createNodeWorkerSupervisorFixture(tempDirs.make("node-worker-supervisor-"), options);
}

function launchInput(workspaceDir: string, launchId: string, prompt = "success") {
  const input = testWorkerLaunchInput(workspaceDir, launchId, prompt);
  input.descriptor.admission.environmentId = `environment-${launchId}`;
  input.descriptor.admission.sessionId = `session-${launchId}`;
  return input;
}

function evictWorkerCredentialsOnRegistration() {
  const { registerSecretValueForRedaction } = secretRegistry;
  // Both launch paths register before sending a turn. Evict every registration so a
  // later launch cannot restore the global secret and hide a missing worker scrubber.
  return vi.spyOn(secretRegistry, "registerSecretValueForRedaction").mockImplementation((value) => {
    registerSecretValueForRedaction(value);
    for (let index = 0; index < 600; index += 1) {
      registerSecretValueForRedaction(`eviction-secret-${index}`);
    }
    expect(secretRegistry.isSecretValueRegisteredForRedaction(value)).toBe(false);
  });
}

describe("node worker supervisor", () => {
  it("bounds output and scrubs launch credentials after registry eviction", async () => {
    const { supervisor, workspaceDir } = fixture();
    const successInput = launchInput(workspaceDir, "secret-success-launch", "secret-success");
    successInput.descriptor.assignment.github = {
      token: "worker-github-token",
      login: "worker-bot",
      branch: "session/worker-1",
    };
    const failureInput = launchInput(workspaceDir, "failure-launch", "secret-fail");
    const overflowInput = launchInput(workspaceDir, "overflow-launch", "overflow");

    const registrations = evictWorkerCredentialsOnRegistration();
    await supervisor.launch(successInput, TEST_WORKER_ENDPOINT);
    await supervisor.launch(failureInput, TEST_WORKER_ENDPOINT);
    await supervisor.launch(overflowInput, TEST_WORKER_ENDPOINT);
    expect(registrations).toHaveBeenCalledTimes(4);
    expect(registrations).toHaveBeenCalledWith(TEST_WORKER_CREDENTIAL);
    expect(registrations).toHaveBeenCalledWith(successInput.descriptor.assignment.github.token);
    const success = await waitForTerminal(supervisor, successInput.launchId);
    const failure = await waitForTerminal(supervisor, failureInput.launchId);
    const overflow = await waitForTerminal(supervisor, overflowInput.launchId);
    const representations = [
      TEST_WORKER_CREDENTIAL,
      encodeURIComponent(TEST_WORKER_CREDENTIAL),
      JSON.stringify(TEST_WORKER_CREDENTIAL).slice(1, -1),
      successInput.descriptor.assignment.github.token,
    ];
    expect(success.state).toBe("completed");
    expect(JSON.parse(success.resultJson ?? "null")).toEqual({
      status: "completed",
      transcriptLeafId: "raw [REDACTED] encoded [REDACTED] github [REDACTED]",
      transcriptNextSeq: 2,
    });
    expect(failure.state).toBe("failed");
    expect(Buffer.byteLength(failure.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
    for (const representation of representations) {
      expect(success.resultJson).not.toContain(representation);
      expect(failure.errorText).not.toContain(representation);
    }
    expect(overflow).toMatchObject({
      state: "failed",
      errorText: expect.stringContaining("stdout exceeded 65536 bytes"),
    });
    await supervisor.close();
  });

  it.each([
    ["raw", "secret-cutoff-raw", TEST_WORKER_CREDENTIAL],
    ["URL", "secret-cutoff-url", encodeURIComponent(TEST_WORKER_CREDENTIAL)],
    ["JSON-escaped", "secret-cutoff-json", JSON.stringify(TEST_WORKER_CREDENTIAL).slice(1, -1)],
  ])(
    "redacts a %s credential representation across the stderr cutoff",
    async (_, prompt, representation) => {
      const { supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, `cutoff-${prompt}`, prompt);

      await supervisor.launch(input, TEST_WORKER_ENDPOINT);
      const failure = await waitForTerminal(supervisor, input.launchId);

      expect(failure.state).toBe("failed");
      expect(Buffer.byteLength(failure.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
      expect(failure.errorText).not.toContain(representation);
      expect(failure.errorText).not.toContain(representation.slice(-8));
      await supervisor.close();
    },
  );

  it("rotates credential scrubbing and drops prior-turn diagnostics when a worker is reused", async () => {
    const { supervisor, workspaceDir } = fixture({ capacity: 1 });
    const first = testWorkerLaunchInput(workspaceDir, "previous-diagnostic", "diagnostic-retain");
    const second = testWorkerLaunchInput(workspaceDir, "rotated-credential", "secret-success");
    second.descriptor.admission.credential = 'fresh worker/"credential\\secret?';
    second.descriptor.assignment.github = {
      token: "rotated-worker-github-token",
      login: "worker-bot",
      branch: "session/worker-1",
    };
    const last = testWorkerLaunchInput(workspaceDir, "fresh-failure", "quiet-fail");
    last.descriptor.admission.credential = "final-worker-credential";
    try {
      const original = await supervisor.launch(first, TEST_WORKER_ENDPOINT);
      await waitForTerminal(supervisor, first.launchId);
      const registrations = evictWorkerCredentialsOnRegistration();
      expect(await supervisor.launch(second, TEST_WORKER_ENDPOINT)).toMatchObject({
        worker: original.worker,
      });
      expect(registrations).toHaveBeenCalledWith(second.descriptor.admission.credential);
      expect(registrations).toHaveBeenCalledWith(second.descriptor.assignment.github.token);
      const completed = await waitForTerminal(supervisor, second.launchId);
      expect(JSON.parse(completed.resultJson ?? "null")).toEqual({
        status: "completed",
        transcriptLeafId: "raw [REDACTED] encoded [REDACTED] github [REDACTED]",
        transcriptNextSeq: 2,
      });

      registrations.mockRestore();
      await supervisor.launch(last, TEST_WORKER_ENDPOINT);
      const failed = await waitForTerminal(supervisor, last.launchId);
      expect(failed).toMatchObject({
        state: "failed",
        errorText: "node worker failed with exit code 7",
      });
      for (const input of [first, second, last]) {
        expect(JSON.stringify(failed)).not.toContain(input.descriptor.admission.credential);
      }
    } finally {
      await supervisor.close();
    }
  });

  it.each([
    [
      "connection-failure",
      "cancelled",
      "worker could not reach gateway gateway.example:18789: certificate rejected ",
    ],
    [
      "connection-deadline",
      "failed",
      "worker admission deadline exceeded after 3 attempts to gateway.example:18789: connect failed: Opening handshake has timed out ",
    ],
  ] as const)(
    "records the child's %s diagnosis in the terminal journal",
    async (prompt, state, errorText) => {
      const { supervisor, workspaceDir } = fixture();
      const input = launchInput(workspaceDir, "connection-failure-launch", prompt);
      await supervisor.launch(input, {
        kind: "websocket",
        url: "wss://gateway.example:18789/__openclaw__/worker",
      });
      if (state === "cancelled") {
        await vi.waitFor(() =>
          expect(fs.existsSync(path.join(workspaceDir, "connection-failure-reported"))).toBe(true),
        );
        await supervisor.cancel(testNodeWorkerLaunchIdentity(input));
      }
      const terminal = await waitForTerminal(supervisor, input.launchId);
      expect(terminal).toMatchObject({ state, errorText: expect.stringContaining(errorText) });
      expect(Buffer.byteLength(terminal.errorText ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
      expect(terminal.errorText).not.toContain(TEST_WORKER_CREDENTIAL);
      await supervisor.close();
    },
  );
});
