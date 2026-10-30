import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  stat: undefined as
    | { isFile: () => boolean; isCharacterDevice: () => boolean }
    | Error
    | undefined,
  tty: false,
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  fstatSync: () => {
    if (state.stat instanceof Error) {
      throw state.stat;
    }
    return state.stat;
  },
}));
vi.mock("node:tty", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:tty")>()),
  isatty: () => state.tty,
}));

const { releaseProcessStdin } = await import("./release-stdin.js");

function fdKind(kind: "file" | "char" | "pipe") {
  return { isFile: () => kind === "file", isCharacterDevice: () => kind === "char" };
}

describe("releaseProcessStdin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    state.tty = false;
  });

  it.each([
    { name: "a pipe", stat: fdKind("pipe"), tty: false, released: true },
    { name: "a TTY", stat: fdKind("char"), tty: true, released: true },
    { name: "an unreadable fd 0", stat: new Error("EBADF"), tty: false, released: true },
    { name: "/dev/null", stat: fdKind("char"), tty: false, released: false },
    { name: "a regular file", stat: fdKind("file"), tty: false, released: false },
  ])("releases stdin over $name: $released", ({ stat, tty, released }) => {
    state.stat = stat;
    state.tty = tty;
    const destroy = vi.fn();
    vi.spyOn(process, "stdin", "get").mockReturnValue({
      destroy,
    } as unknown as typeof process.stdin);
    releaseProcessStdin();
    expect(destroy).toHaveBeenCalledTimes(released ? 1 : 0);
  });
});
