import { info } from "../globals.js";
import type { CliDeps } from "../cli/deps.js";
import type { Provider } from "../utils.js";
import type { RuntimeEnv } from "../runtime.js";

export async function sendCommand(
	opts: {
		to: string;
		message: string;
		wait: string;
		poll: string;
		provider: Provider;
	},
	deps: CliDeps,
	runtime: RuntimeEnv,
) {
	deps.assertProvider(opts.provider);
	const waitSeconds = Number.parseInt(opts.wait, 10);
	const pollSeconds = Number.parseInt(opts.poll, 10);

	if (Number.isNaN(waitSeconds) || waitSeconds < 0) {
		throw new Error("Wait must be >= 0 seconds");
	}
	if (Number.isNaN(pollSeconds) || pollSeconds <= 0) {
		throw new Error("Poll must be > 0 seconds");
	}

	if (opts.provider === "web") {
		if (waitSeconds !== 0) {
			runtime.log(info("Wait/poll are Twilio-only; ignored for provider=web."));
		}
		await deps.sendMessageWeb(opts.to, opts.message, { verbose: false });
		return;
	}

	const result = await deps.sendMessage(opts.to, opts.message, runtime);
	if (!result) return;
	if (waitSeconds === 0) return;
	await deps.waitForFinalStatus(
		result.client,
		result.sid,
		waitSeconds,
		pollSeconds,
		runtime,
	);
}
