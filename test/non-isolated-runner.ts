import fs from "node:fs";
import { type RunnerTestSuite, TestRunner, vi } from "vitest";

type EvaluatedModuleNode = {
	promise?: unknown;
	exports?: unknown;
	evaluated?: boolean;
	importers: Set<string>;
};

type EvaluatedModules = {
	idToModuleMap: Map<string, EvaluatedModuleNode>;
};

function resetEvaluatedModules(modules: EvaluatedModules, resetMocks: boolean) {
	const skipPaths = [
		/\/vitest\/dist\//,
		/vitest-virtual-\w+\/dist/u,
		/@vitest\/dist/u,
		...(resetMocks ? [] : [/^mock:/u]),
	];

	modules.idToModuleMap.forEach((node, modulePath) => {
		if (skipPaths.some((pattern) => pattern.test(modulePath))) {
			return;
		}
		node.promise = undefined;
		node.exports = undefined;
		node.evaluated = false;
		node.importers.clear();
	});
}

export default class OpenClawNonIsolatedRunner extends TestRunner {
	override onCollectStart(file: { filepath: string }) {
		super.onCollectStart(file);
		const orderLogPath = process.env.OPENCLAW_VITEST_FILE_ORDER_LOG?.trim();
		if (orderLogPath) {
			fs.appendFileSync(orderLogPath, `START ${file.filepath}\n`);
		}
	}

	override async onAfterRunSuite(suite: RunnerTestSuite) {
		await super.onAfterRunSuite(suite);
		if (
			this.config.isolate ||
			!("filepath" in suite) ||
			typeof suite.filepath !== "string"
		) {
			return;
		}

		const orderLogPath = process.env.OPENCLAW_VITEST_FILE_ORDER_LOG?.trim();
		if (orderLogPath) {
			fs.appendFileSync(orderLogPath, `END ${suite.filepath}\n`);
		}

		// Mirror the missing cleanup from Vitest isolate mode so shared workers do
		// not carry file-scoped timers, stubs, spies, or stale module state
		// forward into the next file.
		if (vi.isFakeTimers()) {
			vi.useRealTimers();
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.clearAllMocks();
		vi.resetModules();
		this.moduleRunner?.mocker?.reset?.();
		resetEvaluatedModules(
			this.workerState.evaluatedModules as EvaluatedModules,
			true,
		);
	}
}
