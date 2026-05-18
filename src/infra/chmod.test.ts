import { constants } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockChmodSync = vi.hoisted(() => vi.fn());
const mockAccessSync = vi.hoisted(() => vi.fn());
const mockStatSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    chmodSync: mockChmodSync,
    accessSync: mockAccessSync,
    statSync: mockStatSync,
  };
});

import { tryChmodSync } from "./chmod.js";

function makeErrno(code: string, message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

afterEach(() => {
  mockChmodSync.mockReset();
  mockAccessSync.mockReset();
  mockStatSync.mockReset();
});

describe("tryChmodSync", () => {
  it("succeeds when chmod succeeds", () => {
    mockChmodSync.mockImplementation(() => {});
    expect(() => tryChmodSync("/tmp/test", 0o700)).not.toThrow();
    expect(mockChmodSync).toHaveBeenCalledWith("/tmp/test", 0o700);
    expect(mockAccessSync).not.toHaveBeenCalled();
  });

  it("tolerates EPERM when path is accessible", () => {
    mockChmodSync.mockImplementation(() => {
      throw makeErrno("EPERM", "operation not permitted");
    });
    mockAccessSync.mockImplementation(() => {});
    mockStatSync.mockReturnValue({ mode: 0o40700, isDirectory: () => true });
    expect(() => tryChmodSync("/tmp/test", 0o700)).not.toThrow();
  });

  it("rethrows EPERM when path is not accessible", () => {
    const original = makeErrno("EPERM", "operation not permitted");
    mockChmodSync.mockImplementation(() => {
      throw original;
    });
    mockAccessSync.mockImplementation(() => {
      throw new Error("not accessible");
    });
    expect(() => tryChmodSync("/tmp/test", 0o700)).toThrow(original);
  });

  it("tolerates EACCES when path is accessible", () => {
    mockChmodSync.mockImplementation(() => {
      throw makeErrno("EACCES", "permission denied");
    });
    mockAccessSync.mockImplementation(() => {});
    mockStatSync.mockReturnValue({ mode: 0o40700, isDirectory: () => true });
    expect(() => tryChmodSync("/tmp/test", 0o600)).not.toThrow();
  });

  it("tolerates EROFS when path is accessible", () => {
    mockChmodSync.mockImplementation(() => {
      throw makeErrno("EROFS", "read-only file system");
    });
    mockAccessSync.mockImplementation(() => {});
    mockStatSync.mockReturnValue({ mode: 0o40700, isDirectory: () => true });
    expect(() => tryChmodSync("/tmp/test", 0o600)).not.toThrow();
  });

  it("rethrows unexpected errors immediately", () => {
    const original = makeErrno("EINVAL", "invalid argument");
    mockChmodSync.mockImplementation(() => {
      throw original;
    });
    expect(() => tryChmodSync("/tmp/test", 0o700)).toThrow(original);
    expect(mockAccessSync).not.toHaveBeenCalled();
  });

  it("checks X_OK when execute bit is set in mode", () => {
    mockChmodSync.mockImplementation(() => {
      throw makeErrno("EPERM", "operation not permitted");
    });
    mockAccessSync.mockImplementation(() => {});
    mockStatSync.mockReturnValue({ mode: 0o40700, isDirectory: () => true });
    tryChmodSync("/tmp/test", 0o700);
    expect(mockAccessSync).toHaveBeenCalledWith(
      "/tmp/test",
      constants.R_OK | constants.W_OK | constants.X_OK,
    );
  });

  it("checks only R_OK | W_OK when execute bit is not set", () => {
    mockChmodSync.mockImplementation(() => {
      throw makeErrno("EPERM", "operation not permitted");
    });
    mockAccessSync.mockImplementation(() => {});
    mockStatSync.mockReturnValue({ mode: 0o40600, isDirectory: () => true });
    tryChmodSync("/tmp/test", 0o600);
    expect(mockAccessSync).toHaveBeenCalledWith("/tmp/test", constants.R_OK | constants.W_OK);
  });

  it("throws original EPERM, not the accessSync error, when path is inaccessible", () => {
    const original = makeErrno("EPERM", "operation not permitted");
    mockChmodSync.mockImplementation(() => {
      throw original;
    });
    mockAccessSync.mockImplementation(() => {
      throw makeErrno("EACCES", "permission denied");
    });
    expect(() => tryChmodSync("/tmp/test", 0o700)).toThrow(original);
    expect(() => tryChmodSync("/tmp/test", 0o700)).toThrow("operation not permitted");
  });

  it("accepts K8s fsGroup 2775 directory (other r-x, no write)", () => {
    mockChmodSync.mockImplementation(() => {
      throw makeErrno("EPERM", "operation not permitted");
    });
    mockAccessSync.mockImplementation(() => {});
    // 0o42775 = directory + sgid + rwxrwxr-x
    mockStatSync.mockReturnValue({ mode: 0o42775, isDirectory: () => true });
    expect(() => tryChmodSync("/tmp/test", 0o700)).not.toThrow();
  });

  it("rejects world-writable 0777 directory", () => {
    const original = makeErrno("EPERM", "operation not permitted");
    mockChmodSync.mockImplementation(() => {
      throw original;
    });
    mockAccessSync.mockImplementation(() => {});
    mockStatSync.mockReturnValue({ mode: 0o40777, isDirectory: () => true });
    expect(() => tryChmodSync("/tmp/test", 0o700)).toThrow(original);
  });

  it("rejects other-write 0773 directory", () => {
    const original = makeErrno("EPERM", "operation not permitted");
    mockChmodSync.mockImplementation(() => {
      throw original;
    });
    mockAccessSync.mockImplementation(() => {});
    mockStatSync.mockReturnValue({ mode: 0o40773, isDirectory: () => true });
    expect(() => tryChmodSync("/tmp/test", 0o700)).toThrow(original);
  });

  it("rejects chmod failure when private file target has other-read bits", () => {
    const original = makeErrno("EPERM", "operation not permitted");
    mockChmodSync.mockImplementation(() => {
      throw original;
    });
    mockAccessSync.mockImplementation(() => {});
    // 0o100664 = regular file with 0664 — other can read
    mockStatSync.mockReturnValue({ mode: 0o100664, isDirectory: () => false });
    expect(() => tryChmodSync("/tmp/test.db", 0o600)).toThrow(original);
  });

  it("rejects chmod failure when private file target has any other bits", () => {
    const original = makeErrno("EPERM", "operation not permitted");
    mockChmodSync.mockImplementation(() => {
      throw original;
    });
    mockAccessSync.mockImplementation(() => {});
    // other-execute only
    mockStatSync.mockReturnValue({ mode: 0o100661, isDirectory: () => false });
    expect(() => tryChmodSync("/tmp/test.db", 0o600)).toThrow(original);
  });

  it("tolerates chmod failure for K8s fsGroup directory with other r-x bits", () => {
    mockChmodSync.mockImplementation(() => {
      throw makeErrno("EPERM", "operation not permitted");
    });
    mockAccessSync.mockImplementation(() => {});
    mockStatSync.mockReturnValue({ mode: 0o42775, isDirectory: () => true });
    expect(() => tryChmodSync("/tmp/test", 0o700)).not.toThrow();
  });

  it("tolerates chmod failure when file other bits match requested mode", () => {
    mockChmodSync.mockImplementation(() => {
      throw makeErrno("EPERM", "operation not permitted");
    });
    mockAccessSync.mockImplementation(() => {});
    // 0o644 requested, actual 0o644 — other-read matches
    mockStatSync.mockReturnValue({ mode: 0o100644, isDirectory: () => false });
    expect(() => tryChmodSync("/tmp/test", 0o644)).not.toThrow();
  });
});
