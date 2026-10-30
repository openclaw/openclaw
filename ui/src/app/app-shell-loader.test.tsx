/**
 * A shell module download can fail while the document itself is still reachable.
 * That failure must join the shared guarded recovery instead of waiting for a click.
 */
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";

const scheduleStaleChunkReload = vi.hoisted(() => vi.fn(async () => true));

vi.mock("./stale-chunk-reload.ts", async () => {
  const actual =
    await vi.importActual<typeof import("./stale-chunk-reload.ts")>("./stale-chunk-reload.ts");
  return { ...actual, scheduleStaleChunkReload };
});

const { ShellLoadError } = await import("./app-shell-loader.tsx");

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const staleShellError = () =>
  new Error("Failed to fetch dynamically imported module: /src/app/app-host.tsx");

it("starts the guarded shell recovery without a manual retry", () => {
  scheduleStaleChunkReload.mockClear();

  render(() => <ShellLoadError error={staleShellError()} reset={() => {}} />);

  expect(scheduleStaleChunkReload).toHaveBeenCalled();
});

it("leaves an unrelated shell failure on the manual surface", () => {
  scheduleStaleChunkReload.mockClear();

  render(() => <ShellLoadError error={new Error("shell failed")} reset={() => {}} />);

  expect(scheduleStaleChunkReload).not.toHaveBeenCalled();
});
