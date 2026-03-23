import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import {
  ReplayRunsCloseRequestSchema,
  ReplayRunsCloseResponseSchema,
  ReplayRunsCreateRequestSchema,
  ReplayRunsCreateResponseSchema,
  ReplayRunsGetStateResponseSchema,
  ReplayRunsStepRequestSchema,
  ReplayRunsStepResponseSchema,
  TrajectoryV1Schema,
} from "./index.js";

describe("research contracts fixtures", () => {
  it("validates trajectory v1 fixture", async () => {
    const fixturePath = path.join(
      import.meta.dirname,
      "__fixtures__",
      "trajectory",
      "v1",
      "small.json",
    );
    const fixtureRaw = await fs.readFile(fixturePath, "utf8");
    const fixture = JSON.parse(fixtureRaw) as unknown;
    const result = validateJsonSchemaValue({
      schema: TrajectoryV1Schema,
      cacheKey: "research.contracts.fixture.trajectory.v1.small",
      value: fixture,
    });
    expect(result.ok).toBe(true);
  });

  it("validates replay api v1 fixtures", async () => {
    const fixturesRoot = path.join(import.meta.dirname, "__fixtures__", "replay-api", "v1");
    const cases = [
      {
        fileName: "run.create.request.json",
        schema: ReplayRunsCreateRequestSchema,
      },
      {
        fileName: "run.create.response.json",
        schema: ReplayRunsCreateResponseSchema,
      },
      {
        fileName: "run.step.request.json",
        schema: ReplayRunsStepRequestSchema,
      },
      {
        fileName: "run.step.response.json",
        schema: ReplayRunsStepResponseSchema,
      },
      {
        fileName: "run.state.response.json",
        schema: ReplayRunsGetStateResponseSchema,
      },
      {
        fileName: "run.close.request.json",
        schema: ReplayRunsCloseRequestSchema,
      },
      {
        fileName: "run.close.response.json",
        schema: ReplayRunsCloseResponseSchema,
      },
    ];

    for (const fixtureCase of cases) {
      const fixturePath = path.join(fixturesRoot, fixtureCase.fileName);
      const fixtureRaw = await fs.readFile(fixturePath, "utf8");
      const fixture = JSON.parse(fixtureRaw) as unknown;
      const result = validateJsonSchemaValue({
        schema: fixtureCase.schema,
        cacheKey: `research.contracts.fixture.replay.v1.${fixtureCase.fileName}`,
        value: fixture,
      });
      expect(result.ok).toBe(true);
    }
  });
});
