import "./port-command-worker.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { fixture } from "./port-command.integration.test-support.js";
import { runDatabasePortTask } from "./port-command.worker.js";
import { workboardPortProvider } from "./workboard-port.js";

it("repeats owner admission on resume and preserves the refused verified copy", async () => {
  await fixture(async ({ state, source }) => {
    const descriptor = await workboardPortProvider.loadDescriptor();
    const admit = vi.fn(async () => {
      throw new Error("synthetic owner admission refusal");
    });
    vi.spyOn(workboardPortProvider, "loadDescriptor").mockResolvedValue({ ...descriptor, admit });
    const targetPath = path.join(path.dirname(source), "private-target.sqlite");
    const original = fs.readFileSync(source);
    const config = fs.readFileSync(state.configPath);
    const task = {
      operation: "stage" as const,
      sourcePath: source,
      targetPath,
      config: {},
      to: "sqlite" as const,
      storeId: "00000000-0000-4000-8000-000000000001",
      namespace: "unused",
    };
    const scope = { assertCurrent() {} };
    await expect(runDatabasePortTask(task, scope)).rejects.toThrow("stage:");
    expect(admit).toHaveBeenCalledTimes(1);
    const copy = fs.readFileSync(targetPath);
    await expect(runDatabasePortTask({ ...task, resume: true }, scope)).rejects.toThrow("stage:");
    expect(admit).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(targetPath)).toEqual(copy);
    expect(fs.readFileSync(source)).toEqual(original);
    expect(fs.readFileSync(state.configPath)).toEqual(config);
  });
});
