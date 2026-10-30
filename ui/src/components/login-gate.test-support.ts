import { vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import "./login-gate-solid.tsx";

type LoginGateElement = HTMLElement & {
  props: Record<string, unknown>;
  updateComplete: Promise<boolean>;
};
export function gatePart(root: ParentNode, part: string) {
  return root.querySelector<HTMLElement>(`.login-gate__${part}`)!;
}

export async function mountFailure(lastError: string, lastErrorCode: string | null, secret = "") {
  const element = document.createElement("openclaw-login-gate") as LoginGateElement;
  element.props = {
    resourceBasePath: "",
    connected: false,
    lastError,
    lastErrorCode,
    hasToken: Boolean(secret),
    hasPassword: Boolean(secret),
    gatewayUrl: "ws://127.0.0.1:18789",
    secret,
    showGatewaySecret: false,
    onGatewayUrlChange: vi.fn(),
    onSecretChange: vi.fn(),
    onToggleGatewaySecret: vi.fn(),
    onConnect: vi.fn(),
  };
  mountSolid(() => element);
  await element.updateComplete;
  return element;
}
