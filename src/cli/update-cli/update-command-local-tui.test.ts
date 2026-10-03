import { beforeEach, describe, expect, it, vi } from "vitest";

const quiesce = vi.hoisted(() => vi.fn());
const announce = vi.hoisted(() => vi.fn());

vi.mock("../../infra/local-tui-processes.js", () => ({
  announceLocalTuiUpdate: announce,
  quiesceLocalTuiProcessesBeforeUpdate: quiesce,
}));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), log: vi.fn() },
}));

const { stopAfterTuiGate } = await import("./update-command-local-tui.js");

describe("update command local TUI gate", () => {
  let releaseAnnouncement: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    quiesce.mockReset();
    releaseAnnouncement = vi.fn(async () => {});
    announce.mockReset().mockResolvedValue({ pid: 99, release: releaseAnnouncement });
  });

  it("announces and retains gates for every mutation root", async () => {
    const releases = [vi.fn(async () => {}), vi.fn(async () => {})];
    const onLocalTuiGateAcquired = vi.fn();
    const stop = vi.fn(async () => {});
    quiesce.mockImplementation(async (_root: string) => {
      const release = releases[quiesce.mock.calls.length - 1]!;
      return { lockPath: "test", stopped: [], warnings: [], release };
    });

    await stopAfterTuiGate(
      { opts: { json: true }, onLocalTuiGateAcquired },
      ["/first", "/second"],
      () => {},
      stop,
    );

    expect(announce).toHaveBeenCalledWith(["/first", "/second"]);
    expect(quiesce.mock.calls.map(([root]) => root)).toEqual(["/first", "/second"]);
    expect(stop).toHaveBeenCalledWith(["/first", "/second"]);

    await onLocalTuiGateAcquired.mock.calls[0]![0]();

    expect(releases[1]).toHaveBeenCalledBefore(releases[0]!);
    expect(releases[0]).toHaveBeenCalledBefore(releaseAnnouncement);
    expect(releaseAnnouncement).toHaveBeenCalledOnce();
  });

  it("releases acquired gates and the announcement when a later root fails", async () => {
    const firstRelease = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    quiesce
      .mockResolvedValueOnce({
        lockPath: "first",
        stopped: [],
        warnings: [],
        release: firstRelease,
      })
      .mockRejectedValueOnce(new Error("second root refused"));

    await expect(
      stopAfterTuiGate(
        { opts: { json: true }, onLocalTuiGateAcquired: vi.fn() },
        ["/first", "/second"],
        () => {},
        stop,
      ),
    ).rejects.toThrow("second root refused");

    expect(firstRelease).toHaveBeenCalledOnce();
    expect(releaseAnnouncement).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });
});
