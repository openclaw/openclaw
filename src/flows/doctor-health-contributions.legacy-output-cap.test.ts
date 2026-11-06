import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
} from "./doctor-health-contributions.test-support.js";

const note = vi.hoisted(() => vi.fn());
vi.mock("../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../packages/terminal-core/src/note.js")>()),
  note,
}));

beforeEach(() => note.mockClear());

function legacyOutputCapContribution() {
  const contribution = resolveDoctorHealthContributions().find(
    (entry) => entry.id === "doctor:legacy-output-cap",
  );
  if (!contribution) {
    throw new Error("missing doctor:legacy-output-cap contribution");
  }
  return contribution;
}

function customProvider(maxTokens: number): OpenClawConfig {
  return {
    models: {
      providers: {
        custom: {
          baseUrl: "http://localhost:8000/v1",
          models: [{ id: "big-model", name: "Big", maxTokens }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

it("prints saved legacy output caps as a doctor note without failing health", async () => {
  const cfg = customProvider(4096);
  const before = structuredClone(cfg);
  const ctx = createDoctorHealthFlowContext({ cfg });

  await legacyOutputCapContribution().run(ctx);

  expect(note).toHaveBeenCalledTimes(1);
  const [text, title] = note.mock.calls[0] as [string, string];
  expect(title).toBe("Model output caps");
  expect(text).toContain('Provider "custom" pins maxTokens');
  expect(text).toContain("big-model (4096)");
  expect(text).toContain("remove maxTokens");
  expect(ctx.healthOk).not.toBe(false);
  expect(ctx.cfg).toEqual(before);
  expect(ctx.healthFindings?.map((finding) => finding.checkId)).toEqual([
    "core/doctor/legacy-output-cap",
  ]);
});

it("stays quiet when no saved output cap matches a former default", async () => {
  const ctx = createDoctorHealthFlowContext({ cfg: customProvider(16384) });

  await legacyOutputCapContribution().run(ctx);

  expect(note).not.toHaveBeenCalled();
  expect(ctx.healthFindings ?? []).toEqual([]);
});
