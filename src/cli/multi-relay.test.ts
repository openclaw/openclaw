import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "../utils.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WarelayConfig } from "../config/config.js";
import type { CliDeps } from "./deps.js";
import { runMultiProviderRelay } from "./multi-relay.js";

// Mock the monitor modules
vi.mock("../telegram/monitor.js", () => ({
	monitorTelegramProvider: vi.fn(),
}));

vi.mock("../web/auto-reply.js", () => ({
	monitorWebProvider: vi.fn(),
}));

vi.mock("../twilio/monitor.js", () => ({
	monitorTwilio: vi.fn(),
}));

describe("runMultiProviderRelay", () => {
	let mockRuntime: RuntimeEnv;
	let mockConfig: WarelayConfig;
	let mockDeps: CliDeps;
	let originalProcessOn: typeof process.on;
	let originalProcessOff: typeof process.off;
	let sigintHandler: ((...args: unknown[]) => void) | undefined;

	beforeEach(() => {
		mockRuntime = {
			log: vi.fn(),
			error: vi.fn(),
			exit: vi.fn(),
		};

		mockConfig = {
			telegram: { allowFrom: [] },
		};

		mockDeps = {} as CliDeps;

		// Capture SIGINT handler
		originalProcessOn = process.on;
		originalProcessOff = process.off;
		process.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (event === "SIGINT") {
				sigintHandler = handler;
			}
			return process;
		}) as typeof process.on;
		process.off = vi.fn() as typeof process.off;

		vi.clearAllMocks();
	});

	afterEach(() => {
		process.on = originalProcessOn;
		process.off = originalProcessOff;
		sigintHandler = undefined;
	});

	test("starts telegram provider and logs startup message", async () => {
		const { monitorTelegramProvider } = await import(
			"../telegram/monitor.js"
		);
		vi.mocked(monitorTelegramProvider).mockResolvedValue(undefined);

		const providers: Provider[] = ["telegram"];

		const promise = runMultiProviderRelay(providers, mockConfig, mockDeps, {
			verbose: true,
			runtime: mockRuntime,
		});

		// Wait for startup message
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Abort the relay
		if (sigintHandler) {
			sigintHandler();
		}

		await promise;

		expect(mockRuntime.log).toHaveBeenCalledWith(
			"📡 Starting 1 provider(s): telegram",
		);
		expect(monitorTelegramProvider).toHaveBeenCalledWith(
			true,
			mockRuntime,
			expect.any(AbortSignal),
			true,
		);
	});

	test("starts web provider with verbose and webTuning options", async () => {
		const { monitorWebProvider } = await import("../web/auto-reply.js");
		vi.mocked(monitorWebProvider).mockResolvedValue(undefined);

		const providers: Provider[] = ["web"];
		const webTuning = { heartbeatSeconds: 60 };

		const promise = runMultiProviderRelay(providers, mockConfig, mockDeps, {
			verbose: true,
			webTuning,
			runtime: mockRuntime,
		});

		// Wait for startup message
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Abort the relay
		if (sigintHandler) {
			sigintHandler();
		}

		await promise;

		expect(mockRuntime.log).toHaveBeenCalledWith(
			"📡 Starting 1 provider(s): web",
		);
		expect(monitorWebProvider).toHaveBeenCalledWith(
			true,
			undefined,
			true,
			undefined,
			mockRuntime,
			expect.any(AbortSignal),
			{ ...webTuning, suppressStartMessage: true },
		);
	});

	test("starts twilio provider with custom interval and lookback", async () => {
		const { monitorTwilio } = await import("../twilio/monitor.js");
		vi.mocked(monitorTwilio).mockResolvedValue(undefined);

		const providers: Provider[] = ["twilio"];

		const promise = runMultiProviderRelay(providers, mockConfig, mockDeps, {
			verbose: false,
			twilioInterval: 30,
			twilioLookback: 10,
			runtime: mockRuntime,
		});

		// Wait for startup message
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Abort the relay
		if (sigintHandler) {
			sigintHandler();
		}

		await promise;

		expect(mockRuntime.log).toHaveBeenCalledWith(
			"📡 Starting 1 provider(s): twilio",
		);
		expect(monitorTwilio).toHaveBeenCalledWith(30, 10);
	});

	test("starts multiple providers concurrently", async () => {
		const { monitorTelegramProvider } = await import(
			"../telegram/monitor.js"
		);
		const { monitorWebProvider } = await import("../web/auto-reply.js");

		vi.mocked(monitorTelegramProvider).mockResolvedValue(undefined);
		vi.mocked(monitorWebProvider).mockResolvedValue(undefined);

		const providers: Provider[] = ["telegram", "web"];

		const promise = runMultiProviderRelay(providers, mockConfig, mockDeps, {
			verbose: true,
			runtime: mockRuntime,
		});

		// Wait for startup message
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Abort the relay
		if (sigintHandler) {
			sigintHandler();
		}

		await promise;

		expect(mockRuntime.log).toHaveBeenCalledWith(
			"📡 Starting 2 provider(s): telegram, web",
		);
		expect(monitorTelegramProvider).toHaveBeenCalled();
		expect(monitorWebProvider).toHaveBeenCalled();
	});

	test("shows startup complete message after 1.5s", async () => {
		const { monitorTelegramProvider } = await import(
			"../telegram/monitor.js"
		);
		vi.mocked(monitorTelegramProvider).mockImplementation(
			() => new Promise(() => {}), // Never resolves
		);

		const providers: Provider[] = ["telegram"];

		const promise = runMultiProviderRelay(providers, mockConfig, mockDeps, {
			verbose: true,
			runtime: mockRuntime,
		});

		// Wait for startup complete message (1.5s + buffer)
		await new Promise((resolve) => setTimeout(resolve, 1600));

		expect(mockRuntime.log).toHaveBeenCalledWith(
			"✅ All 1 provider(s) active. Listening for messages... (Ctrl+C to stop)",
		);

		// Abort the relay
		if (sigintHandler) {
			sigintHandler();
		}

		// Wait for abort to complete
		await Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 500))]);
	});

	test("handles SIGINT gracefully", async () => {
		const { monitorTelegramProvider } = await import(
			"../telegram/monitor.js"
		);
		let abortSignal: AbortSignal | undefined;
		vi.mocked(monitorTelegramProvider).mockImplementation(
			async (_verbose, _runtime, signal) => {
				abortSignal = signal;
				// Simulate waiting for abort
				return new Promise((resolve) => {
					signal?.addEventListener("abort", () => resolve(undefined));
				});
			},
		);

		const providers: Provider[] = ["telegram"];

		const promise = runMultiProviderRelay(providers, mockConfig, mockDeps, {
			verbose: true,
			runtime: mockRuntime,
		});

		// Wait for monitor to start
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Trigger SIGINT
		if (sigintHandler) {
			sigintHandler();
		}

		await promise;

		expect(mockRuntime.log).toHaveBeenCalledWith(
			"\n⏹  Stopping all providers...",
		);
		expect(mockRuntime.log).toHaveBeenCalledWith("✅ All providers stopped");
		expect(abortSignal?.aborted).toBe(true);
	});

	test("handles provider errors without crashing other providers", async () => {
		const { monitorTelegramProvider } = await import(
			"../telegram/monitor.js"
		);
		const { monitorWebProvider } = await import("../web/auto-reply.js");

		vi.mocked(monitorTelegramProvider).mockRejectedValue(
			new Error("Telegram connection failed"),
		);
		vi.mocked(monitorWebProvider).mockResolvedValue(undefined);

		const providers: Provider[] = ["telegram", "web"];

		const promise = runMultiProviderRelay(providers, mockConfig, mockDeps, {
			verbose: true,
			runtime: mockRuntime,
		});

		// Wait for startup and error handling
		await new Promise((resolve) => setTimeout(resolve, 200));

		// Abort the relay
		if (sigintHandler) {
			sigintHandler();
		}

		await promise;

		expect(mockRuntime.error).toHaveBeenCalledWith(
			"❌ telegram error: Error: Telegram connection failed",
		);
		// Web provider should still have been started
		expect(monitorWebProvider).toHaveBeenCalled();
	});

	test("removes SIGINT handler after completion", async () => {
		const { monitorTelegramProvider } = await import(
			"../telegram/monitor.js"
		);
		vi.mocked(monitorTelegramProvider).mockResolvedValue(undefined);

		const providers: Provider[] = ["telegram"];

		const promise = runMultiProviderRelay(providers, mockConfig, mockDeps, {
			verbose: true,
			runtime: mockRuntime,
		});

		// Wait for startup
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Abort the relay
		if (sigintHandler) {
			sigintHandler();
		}

		await promise;

		expect(process.off).toHaveBeenCalledWith("SIGINT", sigintHandler);
	});

	test("passes suppressStartMessage=true to telegram monitor", async () => {
		const { monitorTelegramProvider } = await import(
			"../telegram/monitor.js"
		);
		vi.mocked(monitorTelegramProvider).mockResolvedValue(undefined);

		const providers: Provider[] = ["telegram"];

		const promise = runMultiProviderRelay(providers, mockConfig, mockDeps, {
			verbose: true,
			runtime: mockRuntime,
		});

		// Wait for startup
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Abort the relay
		if (sigintHandler) {
			sigintHandler();
		}

		await promise;

		expect(monitorTelegramProvider).toHaveBeenCalledWith(
			true,
			mockRuntime,
			expect.any(AbortSignal),
			true, // suppressStartMessage
		);
	});

	test("does not log startup complete if aborted before timeout", async () => {
		const { monitorTelegramProvider } = await import(
			"../telegram/monitor.js"
		);
		vi.mocked(monitorTelegramProvider).mockImplementation(
			async (_verbose, _runtime, signal) => {
				return new Promise((resolve) => {
					signal?.addEventListener("abort", () => resolve(undefined));
				});
			},
		);

		const providers: Provider[] = ["telegram"];

		const promise = runMultiProviderRelay(providers, mockConfig, mockDeps, {
			verbose: true,
			runtime: mockRuntime,
		});

		// Wait briefly, then abort before 1.5s timeout
		await new Promise((resolve) => setTimeout(resolve, 500));

		// Abort the relay
		if (sigintHandler) {
			sigintHandler();
		}

		await promise;

		// Should not have logged startup complete message
		const startupCompleteCalls = vi
			.mocked(mockRuntime.log)
			.mock.calls.filter((call) =>
				String(call[0]).includes("All 1 provider(s) active"),
			);
		expect(startupCompleteCalls.length).toBe(0);
	});

	test("uses default values for twilio interval and lookback", async () => {
		const { monitorTwilio } = await import("../twilio/monitor.js");
		vi.mocked(monitorTwilio).mockResolvedValue(undefined);

		const providers: Provider[] = ["twilio"];

		const promise = runMultiProviderRelay(providers, mockConfig, mockDeps, {
			verbose: false,
			runtime: mockRuntime,
		});

		// Wait for startup
		await new Promise((resolve) => setTimeout(resolve, 100));

		// Abort the relay
		if (sigintHandler) {
			sigintHandler();
		}

		await promise;

		expect(monitorTwilio).toHaveBeenCalledWith(10, 5); // defaults
	});
});
