import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { resolveGatewayService, type ServiceInstallMode } from "./service.js";

// Mock the platform-specific modules
vi.mock("./winsw.js", () => ({
	installWinSwService: vi.fn(),
	uninstallWinSwService: vi.fn(),
	startWinSwService: vi.fn(),
	stopWinSwService: vi.fn(),
	restartWinSwService: vi.fn(),
	isWinSwServiceInstalled: vi.fn().mockResolvedValue(false),
	readWinSwServiceCommand: vi.fn().mockResolvedValue(null),
	readWinSwServiceRuntime: vi.fn().mockResolvedValue({ status: "stopped" }),
}));

vi.mock("./windows-service.js", () => ({
	installWindowsService: vi.fn(),
	uninstallWindowsService: vi.fn(),
	startWindowsService: vi.fn(),
	stopWindowsService: vi.fn(),
	restartWindowsService: vi.fn(),
	isWindowsServiceInstalled: vi.fn().mockResolvedValue(false),
	readWindowsServiceCommand: vi.fn().mockResolvedValue(null),
	readWindowsServiceRuntime: vi.fn().mockResolvedValue({ status: "stopped" }),
}));

vi.mock("./schtasks.js", () => ({
	installScheduledTask: vi.fn(),
	uninstallScheduledTask: vi.fn(),
	startScheduledTask: vi.fn(),
	stopScheduledTask: vi.fn(),
	restartScheduledTask: vi.fn(),
	isScheduledTaskInstalled: vi.fn().mockResolvedValue(false),
	readScheduledTaskCommand: vi.fn().mockResolvedValue(null),
	readScheduledTaskRuntime: vi.fn().mockResolvedValue({ status: "stopped" }),
}));

vi.mock("./launchd.js", () => ({
	installLaunchAgent: vi.fn(),
	uninstallLaunchAgent: vi.fn(),
	startLaunchAgent: vi.fn(),
	stopLaunchAgent: vi.fn(),
	restartLaunchAgent: vi.fn(),
	isLaunchAgentLoaded: vi.fn().mockResolvedValue(false),
	readLaunchAgentProgramArguments: vi.fn().mockResolvedValue(null),
	readLaunchAgentRuntime: vi.fn().mockResolvedValue({ status: "stopped" }),
}));

vi.mock("./systemd.js", () => ({
	installSystemdService: vi.fn(),
	uninstallSystemdService: vi.fn(),
	startSystemdService: vi.fn(),
	stopSystemdService: vi.fn(),
	restartSystemdService: vi.fn(),
	isSystemdServiceEnabled: vi.fn().mockResolvedValue(false),
	readSystemdServiceExecStart: vi.fn().mockResolvedValue(null),
	readSystemdServiceRuntime: vi.fn().mockResolvedValue({ status: "stopped" }),
}));

describe("resolveGatewayService", () => {
	const originalPlatform = process.platform;

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: originalPlatform });
	});

	describe("Windows platform", () => {
		beforeEach(() => {
			Object.defineProperty(process, "platform", { value: "win32" });
		});

		it.each(["auto", "winsw", "scm", "user"] as ServiceInstallMode[])(
			"should create service with mode: %s",
			(mode) => {
				const service = resolveGatewayService({ mode });
				expect(service).toBeDefined();
				expect(service.install).toBeDefined();
				expect(service.uninstall).toBeDefined();
				expect(service.stop).toBeDefined();
				expect(service.restart).toBeDefined();
				expect(service.isLoaded).toBeDefined();
				expect(service.readCommand).toBeDefined();
				expect(service.readRuntime).toBeDefined();
			},
		);

		it("should use default 'auto' mode when not specified", () => {
			const service = resolveGatewayService();
			expect(service).toBeDefined();
		});

		it("should set correct label for winsw mode", () => {
			const service = resolveGatewayService({ mode: "winsw" });
			expect(service.label).toBe("Windows Service (WinSW)");
		});

		it("should set correct label for scm mode", () => {
			const service = resolveGatewayService({ mode: "scm" });
			expect(service.label).toBe("Windows Service (SCM)");
		});

		it("should set correct label for user mode", () => {
			const service = resolveGatewayService({ mode: "user" });
			expect(service.label).toBe("Windows Service (Task Scheduler)");
		});

		it("should set correct label for auto mode", () => {
			const service = resolveGatewayService({ mode: "auto" });
			expect(service.label).toBe("Windows Service");
		});
	});

	describe("macOS platform", () => {
		beforeEach(() => {
			Object.defineProperty(process, "platform", { value: "darwin" });
		});

		it("should return LaunchAgent service", () => {
			const service = resolveGatewayService();
			expect(service.label).toBe("LaunchAgent");
			expect(service.loadedText).toBe("loaded");
			expect(service.notLoadedText).toBe("not loaded");
		});
	});

	describe("Linux platform", () => {
		beforeEach(() => {
			Object.defineProperty(process, "platform", { value: "linux" });
		});

		it("should return systemd service", () => {
			const service = resolveGatewayService();
			expect(service.label).toBe("systemd");
			expect(service.loadedText).toBe("enabled");
			expect(service.notLoadedText).toBe("disabled");
		});
	});

	describe("unsupported platform", () => {
		it("should throw error for unsupported platforms", () => {
			Object.defineProperty(process, "platform", { value: "freebsd" });
			expect(() => resolveGatewayService()).toThrow(
				"Gateway service install not supported on freebsd",
			);
		});
	});
});

describe("GatewayService interface", () => {
	beforeEach(() => {
		Object.defineProperty(process, "platform", { value: "win32" });
	});

	it("should have all required methods", () => {
		const service = resolveGatewayService();
		
		// Check all methods exist
		expect(typeof service.install).toBe("function");
		expect(typeof service.uninstall).toBe("function");
		expect(typeof service.stop).toBe("function");
		expect(typeof service.restart).toBe("function");
		expect(typeof service.isLoaded).toBe("function");
		expect(typeof service.readCommand).toBe("function");
		expect(typeof service.readRuntime).toBe("function");
		
		// Check properties
		expect(typeof service.label).toBe("string");
		expect(typeof service.loadedText).toBe("string");
		expect(typeof service.notLoadedText).toBe("string");
	});
});
