import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createControlUiObservationWriter } from "../../scripts/lib/control-ui-observation-output.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);

it("journals complete records without rewriting the array until completion", async () => {
  const directory = temporary.make("control-ui-observations-");
  const writer = createControlUiObservationWriter(directory);
  const destination = path.join(directory, "observations.json");
  await writeFile(destination, "[]");
  const observations = [
    { artifactPrefix: "passed", status: "passed", evidence: { label: "日本語\nline" } },
    { artifactPrefix: "skipped", status: "skipped", skipReason: "Unsupported viewport" },
    {
      artifactPrefix: "memory",
      status: "passed",
      memory: [{ checkpoint: "after", metrics: { retainedBytes: 42 } }],
    },
  ];
  for (const observation of observations) {
    await writer.record(observation);
    expect(await readFile(destination, "utf8")).toBe("[]");
    expect(
      JSON.parse(
        await readFile(path.join(directory, `${observation.artifactPrefix}.json`), "utf8"),
      ),
    ).toEqual(observation);
  }
  const journal = await readFile(path.join(directory, "observations.jsonl"), "utf8");
  expect(journal.endsWith("\n")).toBe(true);
  expect(
    journal
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual(observations);
  await writer.finish(observations);
  expect(JSON.parse(await readFile(destination, "utf8"))).toEqual(observations);
});

it("propagates record and final publication failures", async () => {
  const directory = temporary.make("control-ui-observation-failures-");
  const writer = createControlUiObservationWriter(directory);
  const journal = path.join(directory, "observations.jsonl");
  await mkdir(journal);
  await expect(writer.record({ artifactPrefix: "failed" })).rejects.toThrow();
  expect(JSON.parse(await readFile(path.join(directory, "failed.json"), "utf8"))).toEqual({
    artifactPrefix: "failed",
  });

  const destination = path.join(directory, "observations.json");
  await mkdir(destination);
  await writeFile(path.join(destination, "retained.txt"), "prior output");
  await expect(writer.finish([{ artifactPrefix: "next" }])).rejects.toThrow();
  expect(await readFile(path.join(destination, "retained.txt"), "utf8")).toBe("prior output");
});
