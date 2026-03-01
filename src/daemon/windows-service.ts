/**
 * Windows Service Control Manager (SCM) Implementation
 *
 * Provides native Windows Service support using SCM (Service Control Manager)
 * instead of Task Scheduler for better reliability and integration.
 *
 * Service Name: OpenClawGateway
 * Log Directory: %PROGRAMDATA%\OpenClaw\logs\
 */

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
	GATEWAY_WINDOWS_SERVICE_NAME,
	resolveGatewayServiceDescription,
} from "./constants.js";
import type {
	GatewayServiceCommandConfig,
	GatewayServiceControlArgs,
	GatewayServiceEnvArgs,
	GatewayServiceInstallArgs,
	GatewayServiceManageArgs,
	GatewayServiceRuntime,
} from "./service-types.js";
import { formatLine } from "./output.js";

const WINDOWS_SERVICE_DISPLAY_NAME = "OpenClaw Gateway";
const WINDOWS_SERVICE_DESCRIPTION = "OpenClaw AI Gateway Service - Multi-channel AI assistant";

/**
 * Execute PowerShell command and return result
 */
async function execPowerShell(command: string): Promise<{
	code: number;
	stdout: string;
	stderr: string;
}> {
	const { execSync } = await import("node:child_process");
	try {
		const stdout = execSync(`powershell -NoProfile -Command "${command}"`, {
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
 * Check if running with administrator privileges
 */
function hasAdminPrivileges(): boolean {
	try {
		execSync("net session", { stdio: "ignore", windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the service binary path
 * Uses the current Node.js executable
 */
function resolveServiceBinaryPath(): string {
	return process.execPath;
}

/**
 * Build the gateway launch command
 */
function resolveGatewayLaunchCommand(args: GatewayServiceInstallArgs): string {
	const scriptPath = "openclaw";
	const portArg = args.programArguments.find((a) => a.match(/^--?port$/))
		? ""
		: "--port 18789";
	const additionalArgs = args.programArguments
		.filter((a) => !a.match(/^--?port$/))
		.join(" ");

	return `${scriptPath} gateway run ${portArg} ${additionalArgs}`.trim();
}

/**
 * Install Windows Service using SCM
 */
export async function installWindowsService({
	env,
	stdout,
	programArguments,
	workingDirectory,
	environment,
	description,
}: GatewayServiceInstallArgs): Promise<{ binPath: string }> {
	// Check admin privileges first
	if (!hasAdminPrivileges()) {
		throw new Error(
			"Administrator privileges required. Please run PowerShell as Administrator and try again.",
		);
	}

	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;
	const binaryPath = resolveServiceBinaryPath();
	const launchCommand = resolveGatewayLaunchCommand({
		...arguments[0],
		programArguments,
	});
	const workDir = workingDirectory ?? process.cwd();

	// Stop and delete existing service if any
	try {
		await execPowerShell(`Stop-Service -Name "${serviceName}" -Force -ErrorAction SilentlyContinue`);
		await execPowerShell(`sc.exe delete "${serviceName}"`);
	} catch {
		// Service may not exist, continue
	}

	// Build environment variables string for the service
	let envString = "";
	if (environment) {
		const envEntries = Object.entries(environment).filter(([, v]) => v);
		envString = envEntries
			.map(([k, v]) => `$env:${k}="${v}"`)
			.join("; ");
	}

	// Create the service using sc.exe
	// Note: sc.exe requires the binary path to be absolute
	const fullCommand = envString
		? `${envString}; ${binaryPath} ${launchCommand}`
		: `${binaryPath} ${launchCommand}`;

	const createResult = await execPowerShell(
		`sc.exe create "${serviceName}" binPath= "${fullCommand}" start= auto DisplayName= "${WINDOWS_SERVICE_DISPLAY_NAME}"`,
	);

	if (createResult.code !== 0) {
		const detail = createResult.stderr || createResult.stdout;
		if (/access is denied/i.test(detail)) {
			throw new Error(
				`Failed to create service: Access denied. Run PowerShell as Administrator.`,
			);
		}
		throw new Error(`Failed to create Windows Service: ${detail}`);
	}

	// Set service description
	await execPowerShell(
		`sc.exe description "${serviceName}" "${description ?? WINDOWS_SERVICE_DESCRIPTION}"`,
	);

	// Configure service to restart on failure
	await execPowerShell(
		`sc.exe failure "${serviceName}" reset= 86400 actions= restart/60000/restart/60000/restart/60000`,
	);

	// Start the service
	const startResult = await execPowerShell(`Start-Service -Name "${serviceName}"`);

	if (startResult.code !== 0) {
		// Service created but failed to start - not a critical error
		stdout.write(
			`${formatLine("Warning", "Service created but failed to start automatically")}\n`,
		);
	}

	stdout.write(
		`${formatLine("Installed Windows Service", serviceName)}\n` +
			`${formatLine("Binary", binaryPath)}\n` +
			`${formatLine("Working Directory", workDir)}\n`,
	);

	return { binPath: binaryPath };
}

/**
 * Uninstall Windows Service
 */
export async function uninstallWindowsService({
	env,
	stdout,
}: GatewayServiceManageArgs): Promise<void> {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;

	// Check if service exists
	const checkResult = await execPowerShell(
		`(Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue).Name`,
	);

	if (checkResult.code !== 0 || !checkResult.stdout.trim()) {
		stdout.write(`Service "${serviceName}" not found\n`);
		return;
	}

	// Stop the service
	await execPowerShell(
		`Stop-Service -Name "${serviceName}" -Force -ErrorAction SilentlyContinue`,
	);

	// Delete the service
	const deleteResult = await execPowerShell(`sc.exe delete "${serviceName}"`);

	if (deleteResult.code !== 0) {
		throw new Error(
			`Failed to delete service: ${deleteResult.stderr || deleteResult.stdout}`,
		);
	}

	stdout.write(`${formatLine("Removed Windows Service", serviceName)}\n`);
}

/**
 * Start Windows Service
 */
export async function startWindowsService({
	stdout,
	env,
}: GatewayServiceControlArgs): Promise<void> {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;

	const result = await execPowerShell(`Start-Service -Name "${serviceName}"`);

	if (result.code !== 0) {
		const detail = result.stderr || result.stdout;
		if (/cannot find/i.test(detail.toLowerCase())) {
			throw new Error(`Service "${serviceName}" is not installed`);
		}
		throw new Error(`Failed to start service: ${detail}`);
	}

	stdout.write(`${formatLine("Started Windows Service", serviceName)}\n`);
}

/**
 * Stop Windows Service
 */
export async function stopWindowsService({
	stdout,
	env,
}: GatewayServiceControlArgs): Promise<void> {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;

	const result = await execPowerShell(
		`Stop-Service -Name "${serviceName}" -Force -ErrorAction Stop`,
	);

	if (result.code !== 0) {
		const detail = result.stderr || result.stdout;
		if (/cannot find/i.test(detail.toLowerCase())) {
			throw new Error(`Service "${serviceName}" is not installed`);
		}
		// Check if service is already stopped
		const statusResult = await execPowerShell(
			`(Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue).Status`,
		);
		if (statusResult.stdout.trim().toLowerCase() === "stopped") {
			stdout.write(`${formatLine("Service already stopped", serviceName)}\n`);
			return;
		}
		throw new Error(`Failed to stop service: ${detail}`);
	}

	stdout.write(`${formatLine("Stopped Windows Service", serviceName)}\n`);
}

/**
 * Restart Windows Service
 */
export async function restartWindowsService(args: GatewayServiceControlArgs): Promise<void> {
	await stopWindowsService(args);
	await startWindowsService(args);
	args.stdout.write(
		`${formatLine("Restarted Windows Service", GATEWAY_WINDOWS_SERVICE_NAME)}\n`,
	);
}

/**
 * Check if Windows Service is installed
 */
export async function isWindowsServiceInstalled(
	args: GatewayServiceEnvArgs,
): Promise<boolean> {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;
	const result = await execPowerShell(
		`(Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue).Status`,
	);

	return result.code === 0 && result.stdout.trim().length > 0;
}

/**
 * Read service command configuration
 */
export async function readWindowsServiceCommand(
	args: GatewayServiceEnvArgs,
): Promise<GatewayServiceCommandConfig | null> {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;
	const result = await execPowerShell(
		`(Get-WmiObject Win32_Service -Filter "Name='${serviceName}'").PathName`,
	);

	if (result.code !== 0) {
		return null;
	}

	const pathName = result.stdout.trim();
	if (!pathName) {
		return null;
	}

	// Parse the command line
	const parts = pathName.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
	const programArguments = parts.slice(1).map((p) => p.replace(/^"|"$/g, ""));

	return {
		programArguments,
	};
}

/**
 * Read service runtime status
 */
export async function readWindowsServiceRuntime(
	args: GatewayServiceEnvArgs,
): Promise<GatewayServiceRuntime> {
	const serviceName = GATEWAY_WINDOWS_SERVICE_NAME;

	// First check if service exists
	const existsResult = await execPowerShell(
		`(Get-Service -Name "${serviceName}" -ErrorAction SilentlyContinue).Name`,
	);

	if (existsResult.code !== 0 || !existsResult.stdout.trim()) {
		return {
			status: "stopped",
			detail: "Service not installed",
			missingUnit: true,
		};
	}

	// Get detailed status
	const statusResult = await execPowerShell(
		`(Get-Service -Name "${serviceName}").Status.ToString()`,
	);

	const startTypeResult = await execPowerShell(
		`(Get-Service -Name "${serviceName}").StartType.ToString()`,
	);

	const status = statusResult.stdout.trim().toLowerCase();
	const startType = startTypeResult.stdout.trim().toLowerCase();

	return {
		status: status === "running" ? "running" : "stopped",
		state: statusResult.stdout.trim(),
		detail: `StartType: ${startTypeResult.stdout.trim()}`,
	};
}
