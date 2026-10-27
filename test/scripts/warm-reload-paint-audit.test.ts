import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyWarmReloadPaintAudit } from "../../scripts/perf/warm-reload-paint-audit.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.ts";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIZkAAAAASUVORK5CYII=",
  "base64",
);

async function fixture() {
  const directory = temporary.make("paint-audit-");
  const runDirectory = path.join(directory, "dashboard", "cold");
  await mkdir(runDirectory, { recursive: true });
  const frames = [
    { file: "/remote/capture/frame-00001.png", epochMs: 1699999999995 },
    { file: "/remote/capture/frame-00002.png", epochMs: 1700000000015 },
    { file: "/remote/capture/frame-00003.png", epochMs: 1700000000045 },
  ];
  for (const frame of frames) {
    await writeFile(path.join(runDirectory, path.basename(frame.file)), tinyPng);
  }
  await writeFile(
    path.join(runDirectory, "frames.json"),
    JSON.stringify({ navigationTimeOrigin: 1700000000000, frames }),
  );
  const reportPath = path.join(directory, "report.json");
  const original = JSON.stringify({
    revision: "capture-head",
    buildIdentity: { gatewayRevision: "product-head" },
    results: [
      {
        route: "dashboard",
        runs: [
          {
            warm: false,
            probe: { timeOrigin: 1700000000999 },
            firstAppCapturedPaintMs: 7,
            firstMainCapturedPaintMs: 30,
            firstDashboardCapturedPaintMs: 31,
          },
        ],
      },
    ],
  });
  await writeFile(reportPath, original);
  const observation = {
    route: "dashboard",
    run: "cold",
    inspected: true,
    appFrame: "frame-00002.png",
    mainFrame: "frame-00003.png",
    dashboardFrame: "frame-00003.png",
  };
  const auditPath = path.join(directory, "observations.json");
  const writeAudit = async (observations: unknown[]) =>
    writeFile(auditPath, JSON.stringify({ observations }));
  await writeAudit([observation]);
  return { reportPath, auditPath, original, observation, writeAudit };
}

it("imports inspected pixel observations using the original capture clock and local frame provenance", async () => {
  const input = await fixture();
  const outputPath = await applyWarmReloadPaintAudit(input.reportPath, input.auditPath);
  const output = JSON.parse(await readFile(outputPath, "utf8"));
  expect(await readFile(input.reportPath, "utf8")).toBe(input.original);
  expect(output).toMatchObject({
    revision: "capture-head",
    buildIdentity: { gatewayRevision: "product-head" },
    analysisRevision: expect.stringMatching(/^[a-f\d]{40}$/u),
    paintAudit: { observationsFile: "observations.json", inspectedReloads: 1 },
  });
  const run = output.results[0].runs[0];
  expect(run).toMatchObject({
    firstAppCandidateFrameMs: 7,
    firstMainCandidateFrameMs: 30,
    firstDashboardCandidateFrameMs: 31,
    auditedPaint: {
      inspected: true,
      navigationTimeOrigin: 1700000000000,
      app: {
        frame: "dashboard/cold/frame-00002.png",
        previousFrame: "dashboard/cold/frame-00001.png",
        atMs: 15,
        previousAtMs: -5,
      },
      main: { frame: "dashboard/cold/frame-00003.png", atMs: 45, previousAtMs: 15 },
      dashboard: { atMs: 45 },
    },
  });
  expect(Object.keys(run).filter((key) => key.endsWith("CapturedPaintMs"))).toEqual([]);
});

it("requires exactly one attested observation per captured reload and actual captured local frames", async () => {
  const input = await fixture();
  for (const observations of [[], [input.observation, input.observation]]) {
    await input.writeAudit(observations);
    await expect(applyWarmReloadPaintAudit(input.reportPath, input.auditPath)).rejects.toThrow(
      /observation/u,
    );
  }
  for (const change of [
    { mainFrame: "../frame-00003.png" },
    { mainFrame: "frame-99999.png" },
    { mainFrame: "frame-00001.png" },
    { inspected: false },
    { dashboardFrame: undefined },
  ]) {
    await input.writeAudit([{ ...input.observation, ...change }]);
    await expect(applyWarmReloadPaintAudit(input.reportPath, input.auditPath)).rejects.toThrow();
  }
  await input.writeAudit([input.observation, { ...input.observation, run: "warm-01" }]);
  await expect(applyWarmReloadPaintAudit(input.reportPath, input.auditPath)).rejects.toThrow(
    "exactly the captured reloads",
  );
  await input.writeAudit([input.observation]);
  await writeFile(
    path.join(path.dirname(input.reportPath), "dashboard/cold/frame-00003.png"),
    "bad",
  );
  await expect(applyWarmReloadPaintAudit(input.reportPath, input.auditPath)).rejects.toThrow(
    "Invalid PNG",
  );
});
