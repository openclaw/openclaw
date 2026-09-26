import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  captureChannelReadAuthority,
  captureChannelReadScope,
  withChannelReadAuthority,
} from "./channel-read-authority.js";

const logError = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ error: logError }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("channel read completion ownership", () => {
  it("keeps nested output until the outer read accepts it without retaining the inner callable", async () => {
    const settle = vi.fn(async (_accepted: boolean) => {});
    let innerAssertion: (() => void) | undefined;
    await withChannelReadAuthority(
      () => {},
      async () => {
        await withChannelReadAuthority(
          () => {},
          async () => {
            innerAssertion = captureChannelReadAuthority();
            captureChannelReadScope()!.registerResource({ key: "created-media", settle });
          },
        );
        expect(() => innerAssertion!()).toThrow("no longer active");
        expect(settle).not.toHaveBeenCalled();
        expect(() => captureChannelReadAuthority()!()).not.toThrow();
      },
    );
    expect(settle).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("retains the creating provider's live check after its inner scope returns", async () => {
    const settle = vi.fn(async (_accepted: boolean) => {});
    let providerActive = true;
    await expect(
      withChannelReadAuthority(
        () => {},
        async () => {
          await withChannelReadAuthority(
            () => {
              if (!providerActive) {
                throw new Error("provider revoked");
              }
            },
            async () => {
              captureChannelReadScope()!.registerResource({ key: "created-media", settle });
            },
          );
          providerActive = false;
        },
      ),
    ).rejects.toThrow("provider revoked");
    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("discards a failed inner read even when its parent catches the error", async () => {
    const outer = vi.fn(async (_accepted: boolean) => {});
    const inner = vi.fn(async (_accepted: boolean) => {});
    await withChannelReadAuthority(
      () => {},
      async () => {
        captureChannelReadScope()!.registerResource({ key: "outer-media", settle: outer });
        await expect(
          withChannelReadAuthority(
            () => {},
            async () => {
              captureChannelReadScope()!.registerResource({ key: "inner-media", settle: inner });
              throw new Error("download failed");
            },
          ),
        ).rejects.toThrow("download failed");
        expect(inner).toHaveBeenCalledExactlyOnceWith(false);
        expect(outer).not.toHaveBeenCalled();
      },
    );
    expect(outer).toHaveBeenCalledExactlyOnceWith(true);
    expect(inner).toHaveBeenCalledOnce();
  });

  it("retains a child's independent source signal until the enclosing read accepts its output", async () => {
    const source = new AbortController();
    const aborted = new Error("child source canceled");
    const settle = vi.fn(async (_accepted: boolean) => {});
    await expect(
      withChannelReadAuthority(
        () => {},
        async () => {
          await withChannelReadAuthority(
            () => {},
            async () => {
              captureChannelReadScope()!.registerResource({ key: "created-media", settle });
            },
            source.signal,
          );
          source.abort(aborted);
        },
      ),
    ).rejects.toBe(aborted);
    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("publishes checked acceptance before asynchronous resource teardown", async () => {
    const closing = createDeferred();
    const release = createDeferred();
    const publish = vi.fn();
    let active = true;
    const operation = withChannelReadAuthority(
      () => {
        if (!active) {
          throw new Error("source closed after acceptance");
        }
      },
      async () => {
        captureChannelReadScope()!.registerResource({
          key: "created-media",
          settle: async (accepted) => {
            expect(accepted).toBe(true);
            expect(publish).toHaveBeenCalledExactlyOnceWith("accepted result");
            closing.resolve();
            await release.promise;
          },
        });
        return "accepted result";
      },
      undefined,
      publish,
    );
    await closing.promise;
    active = false;
    release.resolve();
    await expect(operation).resolves.toBe("accepted result");
  });

  it("preserves authority-error precedence when rejection cleanup also fails", async () => {
    let active = true;
    const revoked = new Error("read revoked");
    const settle = vi.fn(async () => {
      throw new Error("synthetic cleanup failure");
    });
    await expect(
      withChannelReadAuthority(
        () => {
          if (!active) {
            throw revoked;
          }
        },
        async () => {
          captureChannelReadScope()!.registerResource({ key: "created-media", settle });
          active = false;
          throw new Error("provider error");
        },
      ),
    ).rejects.toBe(revoked);
    expect(settle).toHaveBeenCalledExactlyOnceWith(false);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("synthetic cleanup failure"));
  });

  it("shares the callable and owned output with a separately evaluated SDK chunk", async () => {
    vi.resetModules();
    const otherChunk = await import("./channel-read-authority.js");
    const settle = vi.fn(async (_accepted: boolean) => {});
    let retained: (() => void) | undefined;
    await withChannelReadAuthority(
      () => {},
      async () => {
        retained = otherChunk.captureChannelReadAuthority();
        expect(typeof retained).toBe("function");
        expect(retained).toBe(captureChannelReadAuthority());
        retained!();
        otherChunk.captureChannelReadScope()!.registerResource({ key: "created-media", settle });
      },
    );
    expect(settle).toHaveBeenCalledExactlyOnceWith(true);
    expect(() => retained!()).toThrow("no longer active");
  });

  it("leaves calls without a read scope unchanged", async () => {
    expect(captureChannelReadAuthority()).toBeUndefined();
    expect(captureChannelReadScope()).toBeUndefined();
    await expect(withChannelReadAuthority(undefined, async () => "direct result")).resolves.toBe(
      "direct result",
    );
    const error = new Error("direct error");
    await expect(
      withChannelReadAuthority(undefined, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
