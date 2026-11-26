import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_CRON_FORM } from "../../lib/cron/editor-state.ts";
import { validateCronModelThinkingSelection } from "../../lib/cron/model-thinking-validation.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { editJob, waitForCronPage } from "./cron-page.test-support.tsx";
import { cronRpc, mountCronPage } from "./cron-rpc.test-support.ts";
import { createCronViewJob } from "./view.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const fixtureModel = {
  id: "fixture-model",
  provider: "fixture-provider",
  name: "Fixture model",
  thinkingLevels: [
    { id: "off", label: "Off" },
    { id: "ultra", label: "Ultra" },
  ],
};

it("validates only explicit agent settings backed by current catalog evidence", () => {
  const form = {
    ...DEFAULT_CRON_FORM,
    payloadModel: "fixture-provider/fixture-model",
    payloadThinking: "medium",
  };
  const catalog = { models: [fixtureModel], hasSnapshot: true, retired: false };
  expect(validateCronModelThinkingSelection({ ...form, payloadKind: "command" }, catalog)).toEqual(
    {},
  );
  expect(validateCronModelThinkingSelection(form, { ...catalog, retired: true })).toEqual({});
  expect(validateCronModelThinkingSelection(form, { ...catalog, models: [] })).toEqual({});
  expect(
    validateCronModelThinkingSelection(
      { ...form, payloadThinking: "off" },
      {
        ...catalog,
        models: [{ ...fixtureModel, thinkingLevels: [] }],
      },
    ),
  ).toEqual({});
});

it("blocks an incompatible new pair at submit, then saves after a supported repair", async () => {
  const request = cronRpc({
    "models.list": () => ({ models: [fixtureModel] }),
    "cron.add": () => ({ id: "created" }),
  });
  const { page } = mountCronPage(createTestGatewayClient(request));
  page.querySelector<HTMLButtonElement>('[data-test-id="cron-new-task"]')!.click();
  await waitForCronPage(() =>
    expect(page.cronCatalogModels).toEqual(["fixture-provider/fixture-model"]),
  );
  page.patchForm({
    name: "Fixture automation",
    payloadText: "Run the fixture.",
    payloadModel: "fixture-provider/fixture-model",
    payloadThinking: "medium",
  });

  page.submitForm();
  await waitForCronPage(() =>
    expect(page.querySelector<HTMLButtonElement>('[data-test-id="cron-submit"]')?.disabled).toBe(
      true,
    ),
  );
  expect(request.mock.calls.some(([method]) => method === "cron.add")).toBe(false);

  page.patchForm({ payloadThinking: "ultra" });
  page.submitForm();
  await waitForCronPage(() =>
    expect(request).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({
        payload: expect.objectContaining({
          model: "fixture-provider/fixture-model",
          thinking: "ultra",
        }),
      }),
    ),
  );
  page.remove();
});

it("shows an unchanged legacy mismatch but allows its unrelated edit to save", async () => {
  const job = createCronViewJob("legacy-fixture", {
    configRevision: "fixture-config-revision",
    sessionTarget: "isolated",
    payload: {
      kind: "agentTurn",
      message: "Run the fixture.",
      model: "fixture-provider/fixture-model",
      thinking: "medium",
    },
  });
  const request = cronRpc({
    "cron.list": () => ({
      jobs: [job],
      snapshotRevision: "fixture-revision",
      total: 1,
      offset: 0,
      limit: 200,
      hasMore: false,
      nextOffset: null,
    }),
    "models.list": () => ({ models: [fixtureModel] }),
    "cron.update": () => job,
  });
  const { page } = mountCronPage(createTestGatewayClient(request));
  await editJob(page, job.id);
  await waitForCronPage(() =>
    expect(page.textContent).toContain("saved reasoning level is not available"),
  );

  page.patchForm({ name: "Renamed fixture automation" });
  page.submitForm();
  await waitForCronPage(() =>
    expect(request).toHaveBeenCalledWith("cron.update", expect.anything()),
  );
  page.remove();
});
