import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runExec } from "../process/exec.js";
import { readGatewayLockProcessCmdline } from "./gateway-lock-process.js";
import {
  createTailscaleRouteOwnershipConflictError,
  isTailscaleRouteOwnershipConflictError,
} from "./tailscale-route-ownership-error.js";

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: vi.fn(),
}));
vi.mock("./gateway-lock-process.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-lock-process.js")>()),
  readGatewayLockProcessCmdline: vi.fn(),
}));

function serveStatus(proxy = "http://127.0.0.1:4567") {
  return JSON.stringify({
    Foreground: {
      "fixture-session": {
        TCP: { "443": { HTTPS: true } },
        Web: { "fixture.tailnet.ts.net:443": { Handlers: { "/": { Proxy: proxy } } } },
      },
    },
  });
}

beforeEach(() => {
  vi.stubGlobal("process", { ...process, platform: "linux", getuid: () => 1000 });
  vi.mocked(runExec).mockResolvedValue({ stdout: "411 0 /usr/bin/tailscale\n", stderr: "" });
  vi.mocked(readGatewayLockProcessCmdline).mockReturnValue([
    "/usr/bin/tailscale",
    "serve",
    "--yes",
    "--bg=false",
    "4567",
  ]);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe("Tailscale foreground conflict recovery diagnostics", () => {
  it("names matching candidates and conditional TERM commands without claiming ownership", async () => {
    vi.mocked(runExec).mockResolvedValue({
      stdout: [411, 412, 413, 414, 415]
        .map((pid) => `${pid} ${pid === 411 ? 0 : 1000} tailscale`)
        .join("\n"),
      stderr: "",
    });
    const commands = new Map([
      [411, ["tailscale", "serve", "--yes", "--bg=false", "4567"]],
      [412, ["tailscale", "funnel", "--https=443", "http://localhost:4567/"]],
      [413, ["tailscale", "serve", "--https=8443", "4567"]],
      [414, ["tailscale", "serve", "4568"]],
      [415, ["tailscale", "serve", "--bg=true", "4567"]],
    ]);
    vi.mocked(readGatewayLockProcessCmdline).mockImplementation((pid) => commands.get(pid) ?? null);

    const error = await createTailscaleRouteOwnershipConflictError(443, serveStatus());

    expect(isTailscaleRouteOwnershipConflictError(error)).toBe(true);
    expect(error.message).toContain("ownership OpenClaw cannot prove; it was not modified");
    expect(error.message).toContain(
      "Candidate processes matching the HTTPS port and proxy target (ownership unproven)",
    );
    expect(error.message).toContain("PID 411: tailscale serve --yes --bg=false 4567");
    expect(error.message).toContain("`ps -p 411 -o pid,ppid,user,args`");
    expect(error.message).toContain(
      "only after confirming it owns this route, run `sudo kill -TERM 411`",
    );
    expect(error.message).toContain("PID 412: tailscale funnel --https=443 http://localhost:4567/");
    expect(error.message).toContain("run `kill -TERM 412`");
    expect(error.message).not.toMatch(/PID 41[345]/);
    expect(vi.mocked(runExec).mock.calls.map(([command]) => command)).toEqual(["ps"]);
  });

  it.each(["unreadable argv", "failed census"])(
    "preserves refusal and manual recovery when %s",
    async (failure) => {
      if (failure === "unreadable argv") {
        vi.mocked(readGatewayLockProcessCmdline).mockReturnValue(null);
      } else {
        vi.mocked(runExec).mockRejectedValue(new Error("process inspection denied"));
      }
      const error = await createTailscaleRouteOwnershipConflictError(443, serveStatus());

      expect(error.code).toBe("TAILSCALE_ROUTE_OWNERSHIP_CONFLICT");
      expect(error.message).toContain("Tailscale status does not report the claimant PID");
      expect(error.message).toContain("sudo kill -TERM <confirmed-pid>");
      expect(error.message).not.toContain("PID 411");
    },
  );

  it("redacts proxy credentials in both route and candidate command", async () => {
    const proxy = "http://fixture-user:fixture-password@127.0.0.1:4567";
    vi.mocked(readGatewayLockProcessCmdline).mockReturnValue(["tailscale", "serve", proxy]);
    const error = await createTailscaleRouteOwnershipConflictError(443, serveStatus(proxy));

    expect(error.message).toContain("PID 411");
    expect(error.message).not.toContain("fixture-password");
    expect(error.message).not.toContain("fixture-user");
  });

  it("keeps background-route recovery separate from process diagnostics", async () => {
    const error = await createTailscaleRouteOwnershipConflictError(443, "{}");

    expect(error.message).toContain("--https=443 --set-path=/ off");
    expect(runExec).not.toHaveBeenCalled();
  });
});
