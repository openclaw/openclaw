// Regression guard for the deduped `password` prompt wrapper in
// configure.shared. A merge collision once landed two identical
// `export const password` declarations (a build-breaking redeclare). These
// tests pin the single surviving wrapper and prove it still routes secrets
// through clack's masked password prompt instead of a cleartext text prompt.
import type { PasswordOptions } from "@clack/prompts";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clackPassword: vi.fn<(opts: PasswordOptions) => Promise<string>>(async () => "CAPTURED"),
}));

vi.mock("@clack/prompts", () => ({
  password: mocks.clackPassword,
  text: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
}));

import * as configureShared from "./configure.shared.js";

describe("configure.shared password wrapper", () => {
  it("exposes exactly one password export", () => {
    const passwordExports = Object.keys(configureShared).filter((k) => k === "password");
    expect(passwordExports).toHaveLength(1);
    expect(typeof configureShared.password).toBe("function");
  });

  it("routes input through clack's masked password prompt, forwarding params", async () => {
    mocks.clackPassword.mockClear();
    // A caller-supplied mask character; clack masks input with it (default •),
    // so the secret is never rendered in cleartext.
    const result = await configureShared.password({ message: "Gateway password", mask: "•" });

    // The secret goes through the password prompt, not a cleartext text prompt.
    expect(mocks.clackPassword).toHaveBeenCalledTimes(1);
    const args = mocks.clackPassword.mock.calls[0]![0];
    // The mask character is forwarded untouched.
    expect(args.mask).toBe("•");
    // The message survives the wrapper (styled in rich TTY, identity otherwise).
    expect(args.message).toContain("Gateway password");
    // The wrapper passes through the underlying prompt result.
    expect(result).toBe("CAPTURED");
  });
});
