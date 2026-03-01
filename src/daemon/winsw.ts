/**
 * WinSW (Windows Service Wrapper) Implementation
 *
 * Uses WinSW to wrap openclaw gateway as a Windows Service.
 * Provides better logging, automatic restart, and service management.
 *
 * Service Name: OpenClawGateway (from constants.ts)
 * Log Directory: %PROGRAMDATA%\OpenClaw\logs\ (machine) or %LOCALAPPDATA%\OpenClaw\logs\ (user)
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
	GATEWAY_WINDOWS_SERVICE_NAME,
	resolveGatewayServiceDescription,
} from "./constants.js";
import { resolveGatewayStateDir, resolveWindowsLogDir } from "./paths.js";
import type {
	GatewayServiceCommandConfig,
	GatewayServiceControlArgs,
	GatewayServiceEnvArgs,
	GatewayServiceInstallArgs,
	GatewayServiceManageArgs,
} from "./service-types.js";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import { formatLine } from "./output.js";

// ============================================================================
// Constants
// ============================================================================

const SERVICE_DISPLAY_NAME = "OpenClaw Gateway";
const WINSW_EXE_NAME = "openclaw-gateway.exe";
const WINSW_XML_NAME = "openclaw-gateway.xml";

/**
 * Get the path to WinSW binary
 * In production, this should be bundled with the installer
 */
function resolveWinSwPath(): string {
	// Check in the same directory as the executable
	const execDir = path.dirname(process.execPath);
	const winswPath = path.join(execDir, WINSW_EXE_NAME);
	
	if (fs.existsSync(winswPath)) {
		return winswPath;
	}
	
	// Fallback: check in OpenClaw state directory
	const stateDir = resolveGatewayStateDir(process.env as Record<string, string | undefined>);
	const fallbackPath = path.join(stateDir, WINSW_EXE_NAME);
	
	if (fs.existsSync(fallbackPath)) {
		return fallbackPath;
	}
	
	// Return default path for installation
	return path.join(stateDir, WINSW_EXE_NAME);
}

/**
 * Resolve log directory based on service installation type
 * Uses unified path resolver from paths.ts
 */
function resolveLogDirectory(env: Record<string, string | undefined>): string {
	// Check if running in machine mode (admin privileges)
	const isMachineMode = checkAdminPrivileges();

	// Use unified resolver from paths.ts
	const logDir = resolveWindowsLogDir(env, { machineMode: isMachineMode });

	// Ensure log directory exists
	try {
		fs.mkdirSync(logDir, { recursive: true });
	} catch {
		// Fallback to state dir
		const fallbackDir = path.join(resolveGatewayStateDir(env), "logs");
		fs.mkdirSync(fallbackDir, { recursive: true });
		return fallbackDir;
	}

	return logDir;
}

/**
 * Resolve the openclaw executable path
 */
function resolveOpenClawBinaryPath(): string {
	return process.execPath;
}

/**
 * Check if running with administrator privileges
 */
function checkAdminPrivileges(): boolean {
	try {
		execSync("net session", { stdio: "ignore", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Execute WinSW command
 */
function execWinSw(args: string[]): { code: number; stdout: string; stderr: string } {
	const winswPath = resolveWinSwPath();
	
	try {
		const stdout = execSync(`"${winswPath}" ${args.join(" ")}`, {
			encoding: "utf8",
			windowsHide: true,
		});
		return { code: 0, stdout: stdout || "", stderr: "" };
	} catch (error: any) {
		return {
			code: error.status ?? 1,
			stdout: error.stdout ?? "",
			stderr: error.message ?? "",
		};
	}
}

/**
 * Get service status using WinSW
 */
function queryServiceStatus(): {
	running: boolean;
	stopped: boolean;
	paused: boolean;
} {
	const result = execWinSw(["status"]);

	if (result.code !== 0) {
		// Service not installed or not running
		return { running: false, paused: false, stopped: true };
	}

	const output = result.stdout.toLowerCase();
	
	if (output.includes("started") || output.includes("running")) {
		return { running: true, paused: false, stopped: false };
	}
	
	if (output.includes("paused")) {
		return { running: false, paused: true, stopped: false };
	}

	return { running: false, paused: false, stopped: true };
}

/**
 * Generate WinSW XML configuration
 */
function generateWinSwConfig(args: GatewayServiceInstallArgs): string {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;
	const logDir = resolveLogDirectory(args.env);
	const stateDir = resolveGatewayStateDir(args.env);
	const winswPath = resolveWinSwPath();
	
	// Build gateway arguments
	const gatewayArgs = args.programArguments.filter((a) => !a.match(/^--?port$/));
	const portArg = args.programArguments.find((a) => a.match(/^--?port$/))
		? ""
		: "--port 18789";
	
	const fullArgs = `gateway run ${portArg} ${gatewayArgs.join(" ")}`.trim();

	// Build environment variables section
	let envSection = "";
	if (args.environment) {
		for (const [key, value] of Object.entries(args.environment)) {
			if (value) {
				envSection += `  <env name="${key}" value="${value}"/>\n`;
			}
		}
	}

	const description = args.description ?? resolveGatewayServiceDescription({
		env: args.env,
		environment: args.environment,
	});

	return `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>${serviceName}</id>
  <name>${SERVICE_DISPLAY_NAME}</name>
  <description>${description}</description>
  <executable>${winswPath.replace(/\\/g, "\\\\")}</executable>
  <arguments>${fullArgs}</arguments>
  <workingdirectory>${stateDir.replace(/\\/g, "\\\\")}</workingdirectory>
  <logpath>${logDir.replace(/\\/g, "\\\\")}</logpath>
  <logmode>rotate</logmode>
  <onfailure action="restart" delay="60 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <onfailure action="reboot" delay="60 sec"/>
  <resetfailure>86400</resetfailure>
  <stopwait>30</stopwait>
  <startmode>auto</startmode>
${envSection}
</service>`;
}

// ============================================================================
// Public API
// ============================================================================

export async function installWinSwService({
	env,
	stdout,
	programArguments,
	workingDirectory,
	environment,
	description,
}: GatewayServiceInstallArgs): Promise<{ binPath: string }> {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;

	// Check admin privileges first
	if (!checkAdminPrivileges()) {
		throw new Error(
			"Administrator privileges required for Windows Service.\n" +
				"Run PowerShell as Administrator and try again.\n" +
				"\n" +
				"Alternatively, use Task Scheduler (no admin required):\n" +
				"  openclaw service install --mode user",
		);
	}

	// Get service directory
	const stateDir = resolveGatewayStateDir(env);
	const logDir = resolveLogDirectory(env);

	// Ensure directories exist
	fs.mkdirSync(stateDir, { recursive: true });
	fs.mkdirSync(logDir, { recursive: true });

	// Resolve WinSW path
	const winswPath = resolveWinSwPath();
	const targetWinswPath = path.join(stateDir, WINSW_EXE_NAME);
	const targetXmlPath = path.join(stateDir, WINSW_XML_NAME);

	// Copy WinSW if not already in place
	if (!fs.existsSync(targetWinswPath)) {
		// Check if WinSW exists at original path
		if (fs.existsSync(winswPath)) {
			fs.copyFileSync(winswPath, targetWinswPath);
		} else {
			throw new Error(
				`WinSW not found at ${winswPath}. Please ensure WinSW is installed.`,
			);
		}
	}

	// Generate and write XML config
	const xmlConfig = generateWinSwConfig({
		env,
		stdout,
		programArguments,
		workingDirectory,
		environment,
		description,
	});
	fs.writeFileSync(targetXmlPath, xmlConfig, "utf8");

	// Stop and uninstall existing service if any
	const existingStatus = queryServiceStatus();
	if (existingStatus.running || existingStatus.paused || existingStatus.stopped) {
		try {
			execWinSw(["stop"]);
		} catch {
			// Ignore stop errors
		}
		try {
			execWinSw(["uninstall"]);
		} catch {
			// Ignore uninstall errors
		}
	}

	// Install the service
	const installResult = execWinSw(["install"]);

	if (installResult.code !== 0) {
		const detail = installResult.stderr || installResult.stdout;
		if (/access is denied/i.test(detail)) {
			throw new Error(`Failed to create service: Access denied.\nRun PowerShell as Administrator.`);
		}
		throw new Error(`Failed to create Windows Service: ${detail}`);
	}

	// Start the service
	const startResult = execWinSw(["start"]);

	if (startResult.code !== 0) {
		stdout?.write(
			`${formatLine("Warning", "Service created but failed to start automatically")}\n`,
		);
	}

	stdout?.write(
		`${formatLine("Installed Windows Service (WinSW)", serviceName)}\n` +
			`${formatLine("Display Name", SERVICE_DISPLAY_NAME)}\n` +
			`${formatLine("Binary", targetWinswPath)}\n` +
			`${formatLine("Config", targetXmlPath)}\n` +
			`${formatLine("Log Directory", logDir)}\n`,
	);

	return { binPath: targetWinswPath };
}

export async function uninstallWinSwService({
	env,
	stdout,
}: GatewayServiceManageArgs): Promise<void> {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;

	// Check if service exists
	const status = queryServiceStatus();

	if (status.stopped && !status.running && !status.paused) {
		stdout?.write(`Service "${serviceName}" not found\n`);
		return;
	}

	// Stop the service
	if (status.running || status.paused) {
		execWinSw(["stop"]);
	}

	// Uninstall the service
	const uninstallResult = execWinSw(["uninstall"]);

	if (uninstallResult.code !== 0) {
		throw new Error(
			`Failed to delete service: ${uninstallResult.stderr || uninstallResult.stdout}`,
		);
	}

	stdout?.write(`${formatLine("Removed Windows Service (WinSW)", serviceName)}\n`);
}

export async function startWinSwService({
	stdout,
}: GatewayServiceControlArgs): Promise<void> {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;

	const result = execWinSw(["start"]);

	if (result.code !== 0) {
		const detail = result.stderr || result.stdout;
		if (/cannot find/i.test(detail.toLowerCase())) {
			throw new Error(`Service "${serviceName}" is not installed`);
		}
		throw new Error(`Failed to start service: ${detail}`);
	}

	stdout?.write(`${formatLine("Started Windows Service (WinSW)", serviceName)}\n`);
}

export async function stopWinSwService({
	stdout,
}: GatewayServiceControlArgs): Promise<void> {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;

	const result = execWinSw(["stop"]);

	if (result.code !== 0) {
		const detail = result.stderr || result.stdout;
		if (/cannot find/i.test(detail.toLowerCase())) {
			throw new Error(`Service "${serviceName}" is not installed`);
		}
		// Check if already stopped
		const status = queryServiceStatus();
		if (status.stopped) {
			stdout?.write(`${formatLine("Service already stopped", serviceName)}\n`);
			return;
		}
		throw new Error(`Failed to stop service: ${detail}`);
	}

	stdout?.write(`${formatLine("Stopped Windows Service (WinSW)", serviceName)}\n`);
}

export async function restartWinSwService(
	args: GatewayServiceControlArgs,
): Promise<void> {
	await stopWinSwService(args);
	await startWinSwService(args);
	args.stdout?.write(
		`${formatLine("Restarted Windows Service (WinSW)", GATEWAY_WINDOWS_SERVICE_NAME)}\n`,
	);
}

export async function isWinSwServiceInstalled(
	_args: GatewayServiceEnvArgs,
): Promise<boolean> {
	const status = queryServiceStatus();
	return !status.stopped;
}

export async function readWinSwServiceCommand(
	_args: GatewayServiceEnvArgs,
): Promise<GatewayServiceCommandConfig | null> {
	const stateDir = resolveGatewayStateDir(process.env as Record<string, string | undefined>);
	const xmlPath = path.join(stateDir, WINSW_XML_NAME);

	if (!fs.existsSync(xmlPath)) {
		return null;
	}

	try {
		const content = fs.readFileSync(xmlPath, "utf8");
		
		// Parse arguments from XML
		const argsMatch = content.match(/<arguments>(.*?)<\/arguments>/s);
		if (!argsMatch) {
			return null;
		}

		const args = argsMatch[1].trim().split(/\s+/);
		
		// Parse working directory
		const wdMatch = content.match(/<workingdirectory>(.*?)<\/workingdirectory>/s);
		const workingDirectory = wdMatch ? wdMatch[1].trim() : stateDir;

		return {
			programArguments: args,
			workingDirectory,
		};
	} catch {
		return null;
	}
}

export async function readWinSwServiceRuntime(
	_args: GatewayServiceEnvArgs,
): Promise<GatewayServiceRuntime> {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;

	// Check if service exists
	const status = queryServiceStatus();

	if (status.stopped && !status.running && !status.paused) {
		return {
			status: "stopped",
			detail: "Service not installed",
			missingUnit: true,
		};
	}

	// Get additional info from WinSW status
	const result = execWinSw(["status"]);

	let detail = result.stdout.trim();

	return {
		status: status.running ? "running" : "stopped",
		state: status.running ? "Running" : status.paused ? "Paused" : "Stopped",
		detail: detail || undefined,
	};
}
