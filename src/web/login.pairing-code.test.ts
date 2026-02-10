import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginWeb, normalizePhoneNumber, type LoginWebOptions } from "./login.js";

const mockRequestPairingCode = vi.fn().mockResolvedValue("12345678");
const mockWaitForConnectionUpdate = vi.fn().mockResolvedValue(undefined);
const mockWsClose = vi.fn();

vi.mock("./session.js", () => ({
  createWaSocket: vi.fn().mockResolvedValue({
    requestPairingCode: (...args: unknown[]) => mockRequestPairingCode(...args),
    waitForConnectionUpdate: (...args: unknown[]) => mockWaitForConnectionUpdate(...args),
    ws: { close: () => mockWsClose() },
    ev: {
      on: vi.fn(),
      off: vi.fn(),
    },
  }),
  waitForWaConnection: vi.fn().mockResolvedValue(undefined),
  formatError: (err: unknown) => String(err),
  logoutWeb: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    channels: {
      whatsapp: {},
    },
  }),
}));

vi.mock("./accounts.js", () => ({
  resolveWhatsAppAccount: vi.fn().mockReturnValue({
    authDir: "/tmp/test-auth",
  }),
}));

vi.mock("../logger.js", () => ({
  logInfo: vi.fn(),
}));

vi.mock("../globals.js", () => ({
  danger: (s: string) => s,
  info: (s: string) => s,
  success: (s: string) => s,
}));

const mockRuntime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("normalizePhoneNumber", () => {
  it("keeps digits and + prefix", () => {
    expect(normalizePhoneNumber("+1234567890")).toBe("+1234567890");
  });

  it("removes spaces", () => {
    expect(normalizePhoneNumber("+1 234 567 890")).toBe("+1234567890");
  });

  it("removes dashes", () => {
    expect(normalizePhoneNumber("+1-234-567-890")).toBe("+1234567890");
  });

  it("removes parentheses", () => {
    expect(normalizePhoneNumber("(123) 456-7890")).toBe("1234567890");
  });

  it("handles mixed formats", () => {
    expect(normalizePhoneNumber("+1 (234) 567-8901")).toBe("+12345678901");
  });

  it("handles dots as separators", () => {
    expect(normalizePhoneNumber("+1.234.567.8901")).toBe("+12345678901");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizePhoneNumber("  +1234567890  ")).toBe("+1234567890");
  });

  it("handles number without + prefix", () => {
    expect(normalizePhoneNumber("1234567890")).toBe("1234567890");
  });

  it("handles international format with country code", () => {
    expect(normalizePhoneNumber("+44 7123 456789")).toBe("+447123456789");
  });

  it("handles US format with area code in parentheses", () => {
    expect(normalizePhoneNumber("+1 (555) 123-4567")).toBe("+15551234567");
  });
});

describe("loginWeb with pairing code", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requests pairing code when useCode is true and phoneNumber is provided", async () => {
    const opts: LoginWebOptions = {
      useCode: true,
      phoneNumber: "+1234567890",
    };

    const loginPromise = loginWeb(false, undefined, mockRuntime as never, undefined, opts);

    // Advance timers for the final socket close delay
    await vi.advanceTimersByTimeAsync(500);

    await loginPromise;

    expect(mockRequestPairingCode).toHaveBeenCalledWith("1234567890");
  });

  it("waits for socket initialization before requesting pairing code", async () => {
    const opts: LoginWebOptions = {
      useCode: true,
      phoneNumber: "+1234567890",
    };

    const loginPromise = loginWeb(false, undefined, mockRuntime as never, undefined, opts);

    await vi.advanceTimersByTimeAsync(500);

    await loginPromise;

    // Verify waitForConnectionUpdate was called to wait for socket readiness
    expect(mockWaitForConnectionUpdate).toHaveBeenCalledWith(
      expect.any(Function),
      10_000, // PAIRING_CODE_INIT_TIMEOUT_MS
    );
  });

  it("normalizes phone number by removing + prefix", async () => {
    const opts: LoginWebOptions = {
      useCode: true,
      phoneNumber: "+447123456789",
    };

    const loginPromise = loginWeb(false, undefined, mockRuntime as never, undefined, opts);

    await vi.advanceTimersByTimeAsync(500);

    await loginPromise;

    expect(mockRequestPairingCode).toHaveBeenCalledWith("447123456789");
  });

  it("removes spaces from phone number", async () => {
    const opts: LoginWebOptions = {
      useCode: true,
      phoneNumber: "+44 712 345 6789",
    };

    const loginPromise = loginWeb(false, undefined, mockRuntime as never, undefined, opts);

    await vi.advanceTimersByTimeAsync(500);

    await loginPromise;

    expect(mockRequestPairingCode).toHaveBeenCalledWith("447123456789");
  });

  it("removes dashes from phone number", async () => {
    const opts: LoginWebOptions = {
      useCode: true,
      phoneNumber: "+1-234-567-8901",
    };

    const loginPromise = loginWeb(false, undefined, mockRuntime as never, undefined, opts);

    await vi.advanceTimersByTimeAsync(500);

    await loginPromise;

    expect(mockRequestPairingCode).toHaveBeenCalledWith("12345678901");
  });

  it("removes parentheses from phone number", async () => {
    const opts: LoginWebOptions = {
      useCode: true,
      phoneNumber: "+1 (555) 123-4567",
    };

    const loginPromise = loginWeb(false, undefined, mockRuntime as never, undefined, opts);

    await vi.advanceTimersByTimeAsync(500);

    await loginPromise;

    expect(mockRequestPairingCode).toHaveBeenCalledWith("15551234567");
  });

  it("uses QR code when useCode is false", async () => {
    const { createWaSocket } = await import("./session.js");

    const loginPromise = loginWeb(false, undefined, mockRuntime as never, undefined, {
      useCode: false,
    });

    await vi.advanceTimersByTimeAsync(500);

    await loginPromise;

    // When useCode is false, printQr should be true (first arg)
    expect(createWaSocket).toHaveBeenCalledWith(true, false, expect.any(Object));
    expect(mockRequestPairingCode).not.toHaveBeenCalled();
  });

  it("uses QR code when opts not provided", async () => {
    const { createWaSocket } = await import("./session.js");

    const loginPromise = loginWeb(false, undefined, mockRuntime as never, undefined);

    await vi.advanceTimersByTimeAsync(500);

    await loginPromise;

    expect(createWaSocket).toHaveBeenCalledWith(true, false, expect.any(Object));
    expect(mockRequestPairingCode).not.toHaveBeenCalled();
  });

  it("does not print QR when using pairing code", async () => {
    const { createWaSocket } = await import("./session.js");

    const opts: LoginWebOptions = {
      useCode: true,
      phoneNumber: "+1234567890",
    };

    const loginPromise = loginWeb(false, undefined, mockRuntime as never, undefined, opts);

    await vi.advanceTimersByTimeAsync(500);

    await loginPromise;

    // When useCode is true, printQr should be false (first arg)
    expect(createWaSocket).toHaveBeenCalledWith(false, false, expect.any(Object));
  });
});
