import { spawn } from "node:child_process";

const SESSION = "warelay-relay";

export async function spawnRelayTmux(cmd = "pnpm warelay relay --verbose") {
	await killSession(SESSION);
	await new Promise<void>((resolve, reject) => {
		const child = spawn("tmux", ["new", "-d", "-s", SESSION, cmd], {
			stdio: "inherit",
			shell: false,
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`tmux exited with code ${code}`));
		});
	});
	return SESSION;
}

async function killSession(name: string) {
	await new Promise<void>((resolve) => {
		const child = spawn("tmux", ["kill-session", "-t", name], {
			stdio: "ignore",
		});
		child.on("exit", () => resolve());
		child.on("error", () => resolve());
	});
}
