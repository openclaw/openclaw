// Managed Gateway heap tests cover capacity policy and safe native service controls.
import { describe, expect, it } from "vitest";
import {
  formatGatewayHeapLimitReport,
  inspectGatewayHeapLimit,
  resolveGatewayHeapExecArgv,
  resolveGatewayHeapNodeOptions,
} from "./gateway-heap.js";

const MIB = 1024 * 1024;

describe("Gateway service heap controls", () => {
  it.each([
    ["--max-old-space-size 6144", "--max-old-space-size=6144"],
    [
      "--require /tmp/preload.js --max-old-space-size=24576 --inspect=9229",
      "--max-old-space-size=24576",
    ],
  ])("preserves only native heap controls from %s", (input, expected) => {
    expect(resolveGatewayHeapNodeOptions(input)).toBe(expected);
    expect(
      resolveGatewayHeapExecArgv({ programArguments: [], environment: { NODE_OPTIONS: input } }),
    ).toEqual([]);
  });

  it.each(['--max-old-space-size="6144'])(
    "clears absent, unsafe, or invalid service options: %s",
    (input) => {
      expect(resolveGatewayHeapNodeOptions(input)).toBe("");
    },
  );

  it("preserves argv controls after a named gateway preload and ignores application flags", () => {
    const command = [
      "node",
      "--require",
      "gateway",
      "--max_old_space_size=24576",
      "--max-heap-size=32768",
      "cli.js",
      "gateway",
      "--max-old-space-size=1024",
    ];
    const nodeOptions = "--max-old-space-size-percentage=25 --max-old-space-size=4096";
    expect(
      resolveGatewayHeapExecArgv({
        programArguments: command,
        environment: { NODE_OPTIONS: nodeOptions },
      }),
    ).toEqual(["--max-old-space-size=24576", "--max-heap-size=32768"]);
    expect(inspectGatewayHeapLimit(nodeOptions, {}, command)).toMatchObject({
      nodeOptions,
      execArgv: ["--max-old-space-size=24576", "--max-heap-size=32768"],
    });
  });

  it("does not infer automatic provenance when configured heap matches the recommendation", () => {
    const report = inspectGatewayHeapLimit("--max-old-space-size=4096", {
      constrainedMemoryBytes: 8192 * MIB,
      physicalMemoryBytes: 16384 * MIB,
    });
    const text = formatGatewayHeapLimitReport(report);
    expect(text).toContain("service NODE_OPTIONS: --max-old-space-size=4096");
    expect(text).toContain("installer recommendation: 4096 MiB old space");
    expect(text).toContain("runtime V8 ceiling: not measured");
    expect(text).not.toContain("adaptive default");
  });

  it("reports unavailable capacity without inventing a recommendation", () => {
    expect(
      formatGatewayHeapLimitReport(
        inspectGatewayHeapLimit(undefined, {
          constrainedMemoryBytes: 0,
          physicalMemoryBytes: Number.NaN,
        }),
      ),
    ).toContain("installer recommendation: unavailable (unknown capacity; use Node default)");
  });
});
