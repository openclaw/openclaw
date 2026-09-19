import { render, type LitElement } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderGatewayCpuVital, type GatewayStatusSnapshot } from "./gateway-vitals.ts";

const root = document.createElement("div");
afterEach(() => {
  render(null, root);
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
  document.body.append(root);
  render(
    renderGatewayCpuVital(
      statuses.at(-1)!,
      statuses.map((status, at) => ({ status, at })),
    ),
    root,
  );
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
    expect(root.querySelector(".sparkline-tile__value")?.textContent).toContain("258%");
    expect(root.querySelector(".sparkline-tile__secondary")?.textContent).toBe("Host 44%");
    expect(root.querySelectorAll(".sparkline-tile__stack")).toHaveLength(3);
    const detail = root.querySelector(".gateway-cpu-detail")!.textContent!;
    expect(detail).toContain("220%");
    expect(detail).toContain("Loop utilization");
    const chart = root.querySelector<HTMLElement>(".sparkline-tile__chart")!;
    chart.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 0 }));
    await root.querySelector<LitElement>("openclaw-sparkline")!.updateComplete;
    expect(root.querySelector(".sparkline-tile__value")?.textContent).toContain("54%");
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
