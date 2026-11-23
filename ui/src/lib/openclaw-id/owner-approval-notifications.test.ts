import { afterEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { bindOwnerApprovalNotifications } from "./owner-approval-notifications.ts";

const held = vi.hoisted(() => ({
  request: undefined as ((client: GatewayBrowserClient) => void) | undefined,
  action: undefined as (() => void) | undefined,
  shown: vi.fn(),
}));
// mock-isolation: exercise notification target selection without rendering a dialog.
vi.mock("./owner-approval-lifetime.ts", () => ({
  bindOwnerApproval: (_gateway: unknown, request: typeof held.request) => {
    held.request = request;
    return () => {};
  },
}));
vi.mock("../toast.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../toast.ts")>()),
  showToast: (toast: { onAction?: () => void }) => {
    held.action = toast.onAction;
  },
}));

// mock-isolation: capture the selected client without loading device-key state or rendering a dialog.
vi.mock("../../components/openclaw-id/owner-approval-dialog.tsx", () => ({
  showOwnerApprovalDialog: held.shown,
}));

let dispose = () => {};
afterEach(() => {
  dispose();
  held.shown.mockClear();
  held.action = undefined;
  held.request = undefined;
});

it.each([false, true])(
  "rebinds a pending approval toast only to the same Gateway (different: %s)",
  async (different) => {
    const original = { gatewayUrl: "wss://first.example.test" } as GatewayBrowserClient;
    const replacement = {
      gatewayUrl: different ? "wss://other.example.test" : original.gatewayUrl,
    } as GatewayBrowserClient;
    const gateway = {
      snapshot: { phase: "connected", client: original },
    } as unknown as ApplicationGateway;
    dispose = bindOwnerApprovalNotifications(gateway);
    await vi.waitFor(() => expect(held.request).toBeDefined());
    held.request!(original);
    Object.assign(gateway.snapshot, { client: replacement });
    held.action!();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    if (different) {
      expect(held.shown).not.toHaveBeenCalled();
    } else {
      expect(held.shown).toHaveBeenCalledOnce();
      expect(held.shown.mock.calls[0]?.[0].client).toBe(replacement);
    }
  },
);
