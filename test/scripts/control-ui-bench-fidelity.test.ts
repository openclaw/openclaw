import { describe, expect, it } from "vitest";
import {
  compareFidelity,
  fidelityDistribution,
  formatFidelityMarkdown,
  parseFidelityCpuReport,
  parseFidelityRpcCounts,
} from "../../scripts/control-ui-bench-fidelity.js";

function cpuReport(rows: string[], busy = 1000) {
  return parseFidelityCpuReport(
    `private capture preamble\nprofile (1, 'sample') busy ${busy} ms idle 100 ms\n--- self (top 40)\n 999 components/ignored.ts:1 ignored\n--- inclusive by source file (top 45)\n 999 components/ignored.ts\n--- inclusive by function (app sources, top 70)\n${rows.join("\n")}`,
  );
}

const twentyFunctions = Array.from(
  { length: 20 },
  (_, index) => ` ${100 - index} components/panel-${index}.tsx:10 Panel${index}`,
);

function benchRun(
  run: number,
  rows: string[],
  rpcs: Record<string, number> = { "sessions.list": 5 },
) {
  return { run, cpu: cpuReport(rows), rpcs };
}

describe("Control UI bench fidelity report", () => {
  it("reads only app-function data, deduplicates aliases and ignores multiline bodies", () => {
    const report = cpuReport([
      "100 ../../ui/src/components/panel.tsx:10 createPanel",
      " 90 components/panel.tsx:10 x",
      " 80 components/panel.tsx:20 <For each={items()}>",
      "        {(item) => <PrivateText />}\n      </For>",
      " 70 C:\\build\\ui\\src\\lib\\render.ts:7 renderView",
      " 60 node_modules/vendor/index.ts:10 createVendor",
      " 50 get clientHeight",
      "== additional diagnostic callers",
      " 40 components/not-inclusive.ts:1 ignored",
    ]);
    expect(report).toEqual({
      busyMs: 1000,
      functions: [
        {
          source: "components/panel.tsx",
          line: 10,
          names: ["createPanel", "x"],
          milliseconds: 100,
        },
        {
          source: "components/panel.tsx",
          line: 20,
          names: ["<For each={items()}>"],
          milliseconds: 80,
        },
        { source: "lib/render.ts", line: 7, names: ["renderView"], milliseconds: 70 },
      ],
    });
    const output = formatFidelityMarkdown({
      pass: false,
      scenarios: [
        compareFidelity("board", report, { connect: 1 }, [
          benchRun(1, ["10 components/other.ts:1 other"], {}),
        ]),
      ],
    });
    expect(output).not.toContain("private capture preamble");
    expect(output).not.toContain("PrivateText");
    expect(output).not.toContain("ignored");
  });

  it("requires fifteen distinct locations, not aliases, and rejects fewer than twenty references", () => {
    const live = cpuReport(twentyFunctions);
    const pass = compareFidelity("board", live, { "sessions.list": 5 }, [
      benchRun(1, twentyFunctions.slice(0, 15)),
      benchRun(2, twentyFunctions.slice(0, 15)),
    ]);
    expect(pass).toMatchObject({ pass: true, cpuPass: true, matchedFunctions: 15 });
    const fail = compareFidelity("board", live, { "sessions.list": 5 }, [
      benchRun(1, twentyFunctions.slice(0, 14)),
    ]);
    expect(fail).toMatchObject({ pass: false, cpuPass: false, matchedFunctions: 14 });
    const tooShort = cpuReport(twentyFunctions.slice(0, 15));
    expect(compareFidelity("board", tooShort, {}, [benchRun(1, twentyFunctions)]).cpuPass).toBe(
      false,
    );
  });

  it("normalizes by busy time and matches a unique named function after source lines move", () => {
    const live = cpuReport(twentyFunctions);
    const run = benchRun(
      1,
      twentyFunctions.map((row) => row.replace(":10", ":25")),
    );
    run.cpu.busyMs = 2000;
    const result = compareFidelity("chat", live, { "sessions.list": 5 }, [run]);
    expect(result.pass).toBe(true);
    expect(result.functions[0]).toMatchObject({ liveShare: 10, ratio: 0.5, matches: ["name"] });
    expect(result.functions[0]?.benchShare).toEqual({ median: 5, q1: 5, q3: 5, samples: [5] });
    run.cpu.busyMs = 2001;
    expect(compareFidelity("chat", live, { "sessions.list": 5 }, [run]).cpuPass).toBe(false);
  });

  it("keeps per-run RPC differences visible instead of hiding outliers behind a median", () => {
    const live = cpuReport(twentyFunctions);
    const result = compareFidelity("board", live, { "sessions.list": 5 }, [
      benchRun(1, twentyFunctions),
      benchRun(2, twentyFunctions),
      benchRun(3, twentyFunctions, { "sessions.list": 7 }),
    ]);
    expect(result).toMatchObject({ pass: false, cpuPass: true, rpcPass: false });
    expect(result.rpcs[0]).toMatchObject({ delta: 0, pass: false });
    expect(result.rpcs[0]?.bench.samples).toEqual([5, 5, 7]);
    const unexpected = benchRun(1, twentyFunctions);
    unexpected.rpcs = { ...unexpected.rpcs, "chat.history": 2 };
    expect(compareFidelity("board", live, { "sessions.list": 5 }, [unexpected]).rpcPass).toBe(
      false,
    );
  });

  it("reports interpolated quartiles and rejects absent evidence", () => {
    expect(fidelityDistribution([9, 1, 5, 3])).toEqual({
      median: 4,
      q1: 2.5,
      q3: 6,
      samples: [9, 1, 5, 3],
    });
    expect(() => parseFidelityCpuReport("no profile")).toThrow("busy-time");
    expect(() => parseFidelityCpuReport("profile (1) busy 10 ms idle 0 ms")).toThrow("inclusive");
    expect(() => parseFidelityRpcCounts({ "sessions.list": -1 })).toThrow("invalid");
    expect(() => parseFidelityRpcCounts({})).toThrow("nonempty");
    expect(() => compareFidelity("board", cpuReport(twentyFunctions), {}, [])).toThrow(
      "no measured",
    );
  });
});
