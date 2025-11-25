import type { CliDeps } from "../cli/deps.js";
import type { RuntimeEnv } from "../runtime.js";

export async function webhookCommand(
	opts: {
		port: string;
		path: string;
		reply?: string;
		verbose?: boolean;
		yes?: boolean;
	},
	deps: CliDeps,
	runtime: RuntimeEnv,
) {
	const port = Number.parseInt(opts.port, 10);
	if (Number.isNaN(port) || port <= 0 || port >= 65536) {
		throw new Error("Port must be between 1 and 65535");
	}
	await deps.ensurePortAvailable(port);
	const server = await deps.startWebhook(
		port,
		opts.path,
		opts.reply,
		Boolean(opts.verbose),
		runtime,
	);
	return server;
}
