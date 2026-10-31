import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as configJournal from "../config/config-journal-snapshot.js";
import * as configAudit from "../config/io.audit.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  closeTestConfigReloaders,
  createWriteReloaderHarness,
  flushReload,
  makeWrite,
  prepareConfigReloadTest,
} from "./config-reload.test-support.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

beforeEach((context) => {
  prepareConfigReloadTest(context);
  resetGatewayWorkAdmission();
  vi.useFakeTimers();
  vi.spyOn(configAudit, "appendConfigAuditRecord").mockResolvedValue(undefined);
  vi.spyOn(configJournal, "readLatestConfigSnapshotAuditRecordAsync").mockResolvedValue(null);
  vi.spyOn(configJournal, "upsertConfigSnapshotAuditRecordAsync").mockResolvedValue(null);
});

afterEach(async () => {
  await closeTestConfigReloaders();
  resetGatewayWorkAdmission();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("retries a superseded in-process write on its own and settles its receipt", async () => {
  const initial: OpenClawConfig = { gateway: { reload: {} }, hooks: { enabled: false } };
  const next: OpenClawConfig = { gateway: { reload: {} }, hooks: { enabled: true } };
  const harness = createWriteReloaderHarness({ initialConfig: initial });
  harness.onHotReload
    .mockRejectedValueOnce(new GatewayConfigReloadSupersededError())
    .mockRejectedValueOnce(new GatewayConfigReloadSupersededError())
    .mockResolvedValueOnce("applied");
  await harness.reloader.ready;
  const application = createRuntimeConfigWriteApplication();
  const settled = vi.fn();
  void application.result.then(settled);

  harness.emitWrite(
    attachRuntimeConfigWriteApplication(makeWrite(next, "write-retry"), application),
  );
  await flushReload(harness.reloader);
  await flushReload(harness.reloader, 1_000);

  expect(harness.onHotReload).toHaveBeenCalledTimes(3);
  expect(settled).toHaveBeenCalledExactlyOnceWith("applied");
  expect(harness.log.info).toHaveBeenCalledWith(
    "config reload superseded: GatewayConfigReloadSupersededError: config reload superseded by a newer runtime config source",
  );
  expect(harness.log.error).not.toHaveBeenCalled();
});
