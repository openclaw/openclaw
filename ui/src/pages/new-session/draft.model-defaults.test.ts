import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createTestDraft } from "./draft-controller.test-support.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

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
    const controller = createTestDraft(context);
    controller.gateway.synchronize(context.gateway);
    vi.spyOn(controller.gateway, "readPreference").mockReturnValue({
      workspace: "/workspace",
      folder: "/workspace/remembered",
    });
    controller.place.agentsHydrated = true;
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

it("wakes background discovery only while the draft is connected", async () => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const { context, request } = createDraftFixture({
    methods: ["system.info", "environments.list"],
    request: async (method) =>
      method === "system.info"
        ? { machineName: "Visible Gateway" }
        : { profiles: [], environments: [] },
  });
  const draft = createTestDraft(context);
  onTestFinished(() => draft.disconnect());
  draft.connect();
  expect(request.mock.calls.some(([method]) => method === "system.info")).toBe(false);

  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  await waitForFast(() => expect(draft.gateway.gatewayName).toBe("Visible Gateway"));

  draft.disconnect();
  const reads = request.mock.calls.length;
  document.dispatchEvent(new Event("visibilitychange"));
  draft.synchronize();
  expect(request).toHaveBeenCalledTimes(reads);
});
