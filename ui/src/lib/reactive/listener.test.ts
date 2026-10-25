import { describe, expect, it, vi } from "vitest";
import { listen } from "./listener.ts";

describe("native listener lifetime", () => {
  it("retains capture ordering and removes only its own listener", () => {
    const parent = document.createElement("div");
    const child = parent.appendChild(document.createElement("button"));
    const calls: string[] = [];
    const sibling = vi.fn(() => calls.push("sibling"));
    parent.addEventListener("click", sibling);
    const stop = listen(parent, "click", () => calls.push("capture"), { capture: true });
    child.addEventListener("click", () => calls.push("target"));
    child.click();
    expect(calls).toEqual(["capture", "target", "sibling"]);
    calls.length = 0;
    stop();
    stop();
    child.click();
    expect(calls).toEqual(["target", "sibling"]);
  });

  it("retires a multi-target operation without removing another owner's listeners", () => {
    const socket = new EventTarget();
    const track = new EventTarget();
    const scope = new AbortController();
    const receive = vi.fn();
    const ended = vi.fn();
    const sibling = vi.fn();
    socket.addEventListener("message", sibling);
    listen(socket, "message", receive, { signal: scope.signal });
    listen(track, "ended", ended, { signal: scope.signal });
    socket.dispatchEvent(new Event("message"));
    track.dispatchEvent(new Event("ended"));
    expect(receive).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();

    scope.abort();
    scope.abort();
    listen(socket, "message", receive, { signal: scope.signal });
    socket.dispatchEvent(new Event("message"));
    track.dispatchEvent(new Event("ended"));
    expect(scope.signal.aborted).toBe(true);
    expect(receive).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
    expect(sibling).toHaveBeenCalledTimes(2);
  });

  it("keeps native capture and once behavior inside an operation", () => {
    const parent = document.createElement("div");
    const child = parent.appendChild(document.createElement("button"));
    const scope = new AbortController();
    const calls: string[] = [];
    listen(parent, "click", () => calls.push("capture"), {
      capture: true,
      once: true,
      signal: scope.signal,
    });
    listen(child, "click", () => calls.push("target"), { signal: scope.signal });
    child.click();
    child.click();
    scope.abort();
    child.click();
    expect(calls).toEqual(["capture", "target", "target"]);
  });
});
