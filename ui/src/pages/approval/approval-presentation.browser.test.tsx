import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { PendingApprovalSnapshot } from "../../../../packages/gateway-protocol/src/index.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { resolveRenderedColors, type RenderedColor } from "../../test-helpers/rendered-colors.ts";
import { ApprovalContent } from "./approval-presentation.tsx";
import "../../styles/base.css";
import "../../styles/components.css";
import "../../styles/approval.css";

const root = document.documentElement;
const originalAttributes = ["data-theme", "data-theme-mode"].map(
  (name) => [name, root.getAttribute(name)] as const,
);
let unmount: (() => void) | undefined;

afterEach(() => {
  unmount?.();
  unmount = undefined;
  for (const [name, value] of originalAttributes) {
    if (value === null) {
      root.removeAttribute(name);
    } else {
      root.setAttribute(name, value);
    }
  }
});

function luminance(color: RenderedColor) {
  expect(color.alpha).toBe(1);
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue);
}

it.each(["light", "dark"] as const)("keeps Allow once readable in %s mode", async (mode) => {
  root.dataset.theme = mode;
  root.dataset.themeMode = mode;
  const resolveApproval = vi.fn(async () => {});
  const approval: PendingApprovalSnapshot = {
    id: "exec:readable-approval",
    urlPath: "/approve/exec%3Areadable-approval",
    status: "pending",
    createdAtMs: 1_000,
    expiresAtMs: 60_000,
    presentation: {
      kind: "exec",
      commandText: "printf safe",
      allowedDecisions: ["allow-once", "deny"],
    },
  };
  const view = mountSolid(() => (
    <ApprovalContent
      approval={approval}
      page={{
        read: () => ({ resolutionOrigin: "observed", requestError: null }),
        setHeading: () => {},
        hasApprovalGrantAccess: () => true,
        hasGatewayConnection: () => true,
        resolvingDecision: () => null,
        resolveApproval,
      }}
      retry={() => null}
    />
  ));
  unmount = view.unmount;
  const allow = view.getByRole("button", { name: "Allow once" });
  await expect.element(allow).toBeEnabled();
  const style = getComputedStyle(allow);
  const colors = resolveRenderedColors({
    foreground: style.color,
    background: style.backgroundColor,
  });
  const [foreground, background] = [luminance(colors.foreground!), luminance(colors.background!)];
  expect(
    (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
  ).toBeGreaterThanOrEqual(4.5);
  await userEvent.click(allow);
  expect(resolveApproval).toHaveBeenCalledExactlyOnceWith("allow-once");
});
