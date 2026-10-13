import type { LitElement } from "lit";
import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import type { GatewayStatusSnapshot } from "./gateway-vitals.ts";
import { GatewayCpuVital } from "./solid/gateway-vitals.tsx";

const root = document.createElement("div");
let unmount: (() => void) | undefined;
let update: ((statuses: GatewayStatusSnapshot[]) => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  update = undefined;
  root.remove();
});

const measured: GatewayStatusSnapshot = {
  eventLoop: {
    cpuCoreRatio: 2.58,
    utilization: 0.21,
    cpuBreakdown: {
      mainThreadCoreRatio: 0.18,
      workerCoreRatio: 2.2,
      otherThreadsCoreRatio: 0.2,
      hostUtilization: 0.44,
      hostCpuCount: 8,
    },
  },
};

async function show(statuses: GatewayStatusSnapshot[]) {
  if (!update) {
    document.body.append(root);
    const [history, setHistory] = createSignal(statuses);
    update = setHistory;
    unmount = mountSolid(
      () => (
        <GatewayCpuVital
          status={history().at(-1)!}
          history={history().map((status, at) => ({ status, at }))}
        />
      ),
      { container: root },
    ).unmount;
  } else {
    update(statuses);
  }
  flush();
  await root.querySelector<LitElement>("openclaw-sparkline")!.updateComplete;
}

describe("Gateway CPU attribution", () => {
  it("keeps the process headline above one core and aligns host history while scrubbing", async () => {
    const earlier: GatewayStatusSnapshot = {
      eventLoop: {
        ...measured.eventLoop,
        cpuCoreRatio: 0.54,
        cpuBreakdown: { hostUtilization: 0.23 },
      },
    };
    await show([earlier, measured, measured]);
    expect(root.querySelector(".sparkline-tile__value")?.textContent).toContain("2.58 cores");
    expect(root.querySelector(".sparkline-tile__secondary")?.textContent).toBe("Host 44%");
    expect(root.querySelectorAll(".sparkline-tile__stack")).toHaveLength(3);
    const detail = root.querySelector(".gateway-cpu-detail")!.textContent!;
    expect(detail).toContain("Build and tool subprocesses are excluded");
    expect(detail).toContain("220%");
    expect(detail).toContain("Event loop busy");
    expect(
      [...root.querySelectorAll(".gateway-cpu-detail__thread dd")].map((row) => row.textContent),
    ).toEqual(["18%", "220%", "≈20%"]);
    const chart = root.querySelector<HTMLElement>(".sparkline-tile__chart")!;
    chart.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 0 }));
    await root.querySelector<LitElement>("openclaw-sparkline")!.updateComplete;
    expect(root.querySelector(".sparkline-tile__value")?.textContent).toContain("0.54 cores");
    expect(root.querySelector(".sparkline-tile__secondary")?.textContent).toBe("Host 23%");
  });

  it("does not draw unknown attribution as zero or bridge a missing measurement", async () => {
    const unavailable: GatewayStatusSnapshot = { eventLoop: { cpuCoreRatio: 0.5 } };
    await show([measured, unavailable, measured]);
    expect(root.querySelectorAll(".sparkline-tile__stack")).toHaveLength(0);
    expect(root.querySelector("polyline")).not.toBeNull();
    await show([measured, unavailable]);
    expect(root.querySelector(".sparkline-tile__secondary")?.textContent).toBe("Host —");
    expect(
      [...root.querySelectorAll(".gateway-cpu-detail__thread dd")].map((row) => row.textContent),
    ).toEqual(["—", "—", "—"]);
    await show([measured, {}]);
    expect(root.querySelector("polyline")).toBeNull();
    expect(root.querySelector(".sparkline-tile__value")?.textContent?.trim()).toBe("–");
  });
});
