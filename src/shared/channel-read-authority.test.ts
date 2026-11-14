import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureChannelReadAuthority as captureAuthority,
  captureChannelReadScope,
  withChannelReadAuthority as withAuthority,
} from "./channel-read-authority.js";

const logError = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ error: logError }),
}));

afterEach(() => vi.clearAllMocks());

const activeAuthority = () => {};
const register = (settle: (accepted: boolean) => Promise<void>, key = "created-media") =>
  captureChannelReadScope()!.registerResource({ key, settle });
function revocable(message: string) {
  const source = new AbortController();
  const error = new Error(message);
  return {
    error,
    check: () => source.signal.throwIfAborted(),
    revoke: () => source.abort(error),
  };
}

it("shares nested output across SDK chunks until acceptance, then closes the callable", async () => {
  vi.resetModules();
  const other = await import("./channel-read-authority.js");
  const settle = vi.fn(async (_accepted: boolean) => {});
  let innerAssertion: (() => void) | undefined;
  let outerAssertion: (() => void) | undefined;
  await withAuthority(activeAuthority, async () => {
    outerAssertion = captureAuthority();
    await withAuthority(activeAuthority, async () => {
      innerAssertion = other.captureChannelReadAuthority();
      expect(innerAssertion).toBe(captureAuthority());
      innerAssertion!();
      other.captureChannelReadScope()!.registerResource({ key: "created-media", settle });
    });
    expect(() => innerAssertion!()).toThrow("no longer active");
    expect(settle).not.toHaveBeenCalled();
    expect(() => captureAuthority()!()).not.toThrow();
  });
  expect(settle).toHaveBeenCalledExactlyOnceWith(true);
  expect(() => outerAssertion!()).toThrow("no longer active");
});

it.each(["provider", "source signal"])(
  "retains child %s revocation until the outer read accepts output",
  async (authority) => {
    const settle = vi.fn(async (_accepted: boolean) => {});
    const source = new AbortController();
    const provider = revocable("child read revoked");
    await expect(
      withAuthority(activeAuthority, async () => {
        await withAuthority(
          provider.check,
          async () => register(settle),
          authority === "source signal" ? source.signal : undefined,
        );
        if (authority === "provider") {
          provider.revoke();
        } else {
          source.abort(provider.error);
        }
      }),
    ).rejects.toBe(provider.error);
    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  },
);

it("discards a failed inner read even when its parent catches the error", async () => {
  const outer = vi.fn(async (_accepted: boolean) => {});
  const inner = vi.fn(async (_accepted: boolean) => {});
  await withAuthority(activeAuthority, async () => {
    register(outer, "outer-media");
    await expect(
      withAuthority(activeAuthority, async () => {
        register(inner, "inner-media");
        throw new Error("download failed");
      }),
    ).rejects.toThrow("download failed");
    expect(inner).toHaveBeenCalledExactlyOnceWith(false);
    expect(outer).not.toHaveBeenCalled();
  });
  expect(outer).toHaveBeenCalledExactlyOnceWith(true);
  expect(inner).toHaveBeenCalledOnce();
});

it("publishes checked acceptance before asynchronous resource teardown", async () => {
  const closing = createDeferred();
  const release = createDeferred();
  const publish = vi.fn();
  const authority = revocable("source closed after acceptance");
  const operation = withAuthority(
    authority.check,
    async () => {
      register(async (accepted) => {
        expect(accepted).toBe(true);
        expect(publish).toHaveBeenCalledExactlyOnceWith("accepted result");
        closing.resolve();
        await release.promise;
      });
      return "accepted result";
    },
    undefined,
    publish,
  );
  await closing.promise;
  authority.revoke();
  release.resolve();
  await expect(operation).resolves.toBe("accepted result");
});

it("preserves authority-error precedence when rejection cleanup also fails", async () => {
  const authority = revocable("read revoked");
  const settle = vi.fn(async () => {
    throw new Error("synthetic cleanup failure");
  });
  await expect(
    withAuthority(authority.check, async () => {
      register(settle);
      authority.revoke();
      throw new Error("provider error");
    }),
  ).rejects.toBe(authority.error);
  expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  expect(logError).toHaveBeenCalledWith(expect.stringContaining("synthetic cleanup failure"));
});

it("leaves calls without a read scope unchanged", async () => {
  expect(captureAuthority()).toBeUndefined();
  expect(captureChannelReadScope()).toBeUndefined();
  await expect(withAuthority(undefined, async () => "direct result")).resolves.toBe(
    "direct result",
  );
  const error = new Error("direct error");
  await expect(
    withAuthority(undefined, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
});
