import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import { NewSessionDraftController } from "./draft-controller.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { TestReactiveControllerHost } from "./reactive-controller-host.test-support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

it.each(["last-used", "configured"] as const)(
  "publishing %s model defaults does not restart pending folder validation",
  async (policy) => {
    const listing = createDeferred<unknown>();
    let directoryReads = 0;
    const fixture = createDraftFixture({
      agents: [
        {
          id: "main",
          workspace: "/workspace",
          workspaceGit: false,
          model: { primary: "openai/default-model" },
        },
      ],
      request: (method) => {
        if (method === "fs.listDir") {
          directoryReads++;
          return directoryReads === 1
            ? listing.promise
            : Promise.resolve({ path: "/workspace/remembered", entries: [] });
        }
        return Promise.resolve({});
      },
    });
    const { context } = fixture;
    Object.assign(context.config.current, { newSessionModelDefaults: policy });
    const controller = new NewSessionDraftController(
      new TestReactiveControllerHost(),
      () => ({ context, data: undefined, isConnected: true }),
      {
        requestUpdate: vi.fn(),
        closeTransientUi: vi.fn(),
        querySelector: () => null,
        activeElement: () => null,
        body: () => null,
        onInvalidate: vi.fn(),
        onRecoveryReady: vi.fn(),
      },
    );
    controller.gateway.synchronize(context.gateway);
    vi.spyOn(controller.gateway, "readPreference").mockReturnValue({
      workspace: "/workspace",
      folder: "/workspace/remembered",
    });
    controller.place.setAgentsHydrated(true);
    controller.place.adoptAgentDefaults();
    expect(directoryReads).toBe(1);
    expect(controller.place.folderSubmissionBlocked()).toBe(true);
    controller.synchronizeSelections();
    expect(directoryReads).toBe(1);
    expect(controller.place.folderSubmissionBlocked()).toBe(true);
    listing.reject(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "ENOENT: remembered folder is gone",
      }),
    );
    await listing.promise.catch(() => undefined);
    await Promise.resolve();
    expect(controller.place.folderSubmissionBlocked()).toBe(false);
    expect(controller.place.folder).toBe("/workspace");
    controller.disconnect();
    fixture.flow.disconnect();
  },
);
