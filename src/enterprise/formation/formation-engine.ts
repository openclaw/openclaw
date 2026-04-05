/**
 * Business Formation Engine
 *
 * Automates the full lifecycle of business entity creation:
 * 1. Name availability check
 * 2. Articles of Organization / Incorporation filing
 * 3. Operating Agreement generation
 * 4. EIN application with the IRS
 * 5. Registered agent setup
 * 6. Business bank account opening
 * 7. Compliance calendar creation
 *
 * Each step integrates with external APIs in production.
 * The Master Agent orchestrates this via the form_business tool.
 */

import crypto from "node:crypto";
import type { OrgId } from "../tenants/types.js";
import type {
	BusinessEntity,
	ComplianceEvent,
	EntityType,
	FormationRequest,
	FormationStep,
	FormationStepName,
	USState,
} from "./types.js";
import {
	FORMATION_SERVICE_FEE_CENTS,
	FORMATION_STEPS,
	REGISTERED_AGENT_ANNUAL_FEE_CENTS,
	STATE_FILING_FEES,
} from "./types.js";
import { deductCredits } from "../billing/credits.js";

// ── Entity Store ─────────────────────────────────────────────────────────────

const entityStore = new Map<string, BusinessEntity>();

// ── Name Availability ────────────────────────────────────────────────────────

export interface NameCheckResult {
	available: boolean;
	name: string;
	state: USState;
	similarNames?: string[];
	suggestion?: string;
}

/**
 * Check if a business name is available in the given state.
 *
 * Production integration:
 * - Calls the Secretary of State API or scrapes the state's business search
 * - For DE/WY/NV: direct API integration
 * - For other states: uses a third-party service (e.g., Incfile, ZenBusiness API)
 */
export function checkNameAvailability(
	name: string,
	state: USState,
	entityType: EntityType,
): NameCheckResult {
	// In production: actual state database lookup
	// Common suffix requirements: LLC needs ", LLC" or ", L.L.C."
	const suffixMap: Record<string, string> = {
		llc: ", LLC",
		s_corp: ", Inc.",
		c_corp: ", Inc.",
	};
	const suffix = suffixMap[entityType] ?? "";
	const fullName = name.endsWith(suffix) ? name : `${name}${suffix}`;

	return {
		available: true, // Placeholder — real check hits state API
		name: fullName,
		state,
	};
}

// ── Formation Orchestrator ───────────────────────────────────────────────────

/**
 * Start the business formation process.
 *
 * Returns immediately with the entity ID. Steps execute async.
 * The Master Agent can check status via getFormationStatus().
 */
export function startFormation(orgId: OrgId, request: FormationRequest): BusinessEntity {
	const entityId = `entity_${crypto.randomBytes(12).toString("hex")}`;

	// Charge the formation service fee
	const serviceFee = FORMATION_SERVICE_FEE_CENTS[request.entityType];
	if (serviceFee > 0) {
		deductCredits(orgId, serviceFee, "agent_run", {
			action: "business_formation",
			entityType: request.entityType,
			state: request.state,
		});
	}

	const steps: FormationStep[] = FORMATION_STEPS.map((step) => ({
		step,
		status: "pending" as const,
	}));

	// Skip steps that don't apply
	if (!request.requestEin) {
		const einStep = steps.find((s) => s.step === "ein_application");
		if (einStep) einStep.status = "completed";
	}
	if (!request.openBankAccount) {
		const bankStep = steps.find((s) => s.step === "bank_account_opening");
		if (bankStep) bankStep.status = "completed";
	}
	if (request.registeredAgentService === "own") {
		const raStep = steps.find((s) => s.step === "registered_agent_setup");
		if (raStep) raStep.status = "completed";
	}

	const entity: BusinessEntity = {
		id: entityId,
		orgId,
		companyName: request.companyName,
		entityType: request.entityType,
		state: request.state,
		status: "forming",
		steps,
		complianceCalendar: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	};

	entityStore.set(entityId, entity);

	// Kick off the formation pipeline
	processFormationPipeline(entityId, request);

	return entity;
}

/**
 * Process formation steps sequentially.
 *
 * In production, each step calls an external API:
 * - Name check: State SOS API
 * - State filing: Formation API (Stripe Atlas, Incfile, ZenBusiness, or direct SOS)
 * - Operating agreement: Generated from template + LLM customization
 * - EIN: IRS SS-4 online application (automated form submission)
 * - Registered agent: Registered agent provider API
 * - Bank account: Mercury/Relay/Bluevine API
 * - Compliance calendar: Generated from state requirements
 */
function processFormationPipeline(entityId: string, request: FormationRequest): void {
	const entity = entityStore.get(entityId);
	if (!entity) return;

	// Step 1: Name check
	advanceStep(entity, "name_availability_check", () => {
		const result = checkNameAvailability(request.companyName, request.state, request.entityType);
		if (!result.available) {
			return { error: `Name "${request.companyName}" is not available in ${request.state}` };
		}
		entity.companyName = result.name;
		return { externalRef: result.name };
	});

	// Step 2: Articles of Organization
	advanceStep(entity, "articles_of_organization", () => {
		// In production: generate articles from template, have user review
		return { externalRef: `articles_${entityId}` };
	});

	// Step 3: State filing
	advanceStep(entity, "state_filing", () => {
		// In production: submit to state SOS API
		const fileNumber = `${request.state}-${Date.now().toString(36).toUpperCase()}`;
		entity.stateFileNumber = fileNumber;
		return { externalRef: fileNumber };
	});

	// Step 4: Operating agreement
	advanceStep(entity, "operating_agreement", () => {
		// In production: LLM generates customized operating agreement
		return { externalRef: `oa_${entityId}` };
	});

	// Step 5: EIN
	if (request.requestEin) {
		advanceStep(entity, "ein_application", () => {
			// In production: automated IRS SS-4 submission
			// This takes 4-6 weeks by mail, instant online
			return {
				status: "in_progress" as const,
				actionRequired: "EIN application submitted. IRS processes online applications instantly on weekdays 7am-10pm ET.",
			};
		});
	}

	// Step 6: Registered agent
	if (request.registeredAgentService === "included") {
		advanceStep(entity, "registered_agent_setup", () => {
			return { externalRef: `ra_${entityId}` };
		});
	}

	// Step 7: Bank account
	if (request.openBankAccount) {
		advanceStep(entity, "bank_account_opening", () => {
			const provider = request.bankProvider ?? "mercury";
			entity.bankAccount = {
				provider,
				accountId: `acct_${crypto.randomBytes(8).toString("hex")}`,
				status: "pending",
			};
			return {
				status: "in_progress" as const,
				actionRequired: `Bank account application submitted to ${provider}. Identity verification may be required.`,
			};
		});
	}

	// Step 8: Compliance calendar
	advanceStep(entity, "compliance_calendar_setup", () => {
		entity.complianceCalendar = generateComplianceCalendar(entityId, request.state, request.entityType);
		return {};
	});

	// Check if all steps are done
	const allDone = entity.steps.every((s) => s.status === "completed" || s.status === "in_progress");
	if (allDone) {
		entity.status = "active";
		entity.formationDate = new Date();
	}

	entity.updatedAt = new Date();
}

function advanceStep(
	entity: BusinessEntity,
	stepName: FormationStepName,
	execute: () => { externalRef?: string; error?: string; status?: "in_progress"; actionRequired?: string },
): void {
	const step = entity.steps.find((s) => s.step === stepName);
	if (!step || step.status === "completed") return;

	step.status = "in_progress";
	step.startedAt = new Date();

	try {
		const result = execute();
		if (result.error) {
			step.status = "failed";
			step.error = result.error;
		} else if (result.status === "in_progress") {
			step.status = "requires_action";
			step.actionRequired = result.actionRequired;
		} else {
			step.status = "completed";
			step.completedAt = new Date();
		}
		if (result.externalRef) {
			step.externalRef = result.externalRef;
		}
	} catch (err) {
		step.status = "failed";
		step.error = err instanceof Error ? err.message : "Unknown error";
	}
}

// ── Compliance Calendar ──────────────────────────────────────────────────────

function generateComplianceCalendar(
	entityId: string,
	state: USState,
	entityType: EntityType,
): ComplianceEvent[] {
	const events: ComplianceEvent[] = [];
	const now = new Date();
	const nextYear = new Date(now.getFullYear() + 1, 0, 1);

	// Annual report (most states require this)
	events.push({
		id: `comp_${crypto.randomBytes(6).toString("hex")}`,
		entityId,
		name: "Annual Report Filing",
		description: `File annual report with ${state} Secretary of State`,
		dueDate: new Date(nextYear.getFullYear(), getAnnualReportMonth(state), 1),
		recurring: true,
		recurrenceCron: `0 0 1 ${getAnnualReportMonth(state) + 1} *`, // 1st of the month
		status: "upcoming",
	});

	// Franchise tax (DE, TX, etc.)
	if (state === "DE" || state === "TX" || state === "CA") {
		events.push({
			id: `comp_${crypto.randomBytes(6).toString("hex")}`,
			entityId,
			name: "Franchise Tax Payment",
			description: `Pay ${state} franchise tax`,
			dueDate: new Date(nextYear.getFullYear(), 2, 1), // March 1
			recurring: true,
			recurrenceCron: "0 0 1 3 *",
			status: "upcoming",
		});
	}

	// Registered agent renewal
	events.push({
		id: `comp_${crypto.randomBytes(6).toString("hex")}`,
		entityId,
		name: "Registered Agent Renewal",
		description: "Renew registered agent service",
		dueDate: new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()),
		recurring: true,
		recurrenceCron: `0 0 ${now.getDate()} ${now.getMonth() + 1} *`,
		status: "upcoming",
	});

	// Federal tax deadlines
	if (entityType === "llc" || entityType === "sole_prop") {
		events.push({
			id: `comp_${crypto.randomBytes(6).toString("hex")}`,
			entityId,
			name: "Federal Tax Return (Schedule C / 1065)",
			description: "File federal tax return",
			dueDate: new Date(nextYear.getFullYear(), 3, 15), // April 15
			recurring: true,
			recurrenceCron: "0 0 15 4 *",
			status: "upcoming",
		});
	} else {
		events.push({
			id: `comp_${crypto.randomBytes(6).toString("hex")}`,
			entityId,
			name: "Corporate Tax Return (Form 1120/1120S)",
			description: "File corporate federal tax return",
			dueDate: new Date(nextYear.getFullYear(), 2, 15), // March 15
			recurring: true,
			recurrenceCron: "0 0 15 3 *",
			status: "upcoming",
		});
	}

	// Quarterly estimated taxes
	for (const month of [3, 5, 8, 0]) { // Apr 15, Jun 15, Sep 15, Jan 15
		const year = month === 0 ? nextYear.getFullYear() + 1 : nextYear.getFullYear();
		events.push({
			id: `comp_${crypto.randomBytes(6).toString("hex")}`,
			entityId,
			name: "Quarterly Estimated Tax Payment",
			description: `Q${month === 3 ? 1 : month === 5 ? 2 : month === 8 ? 3 : 4} estimated tax payment`,
			dueDate: new Date(year, month, 15),
			recurring: true,
			recurrenceCron: `0 0 15 ${month + 1} *`,
			status: "upcoming",
		});
	}

	return events;
}

function getAnnualReportMonth(state: USState): number {
	// Varies by state — simplified mapping
	const monthMap: Partial<Record<USState, number>> = {
		DE: 2, // March
		WY: 0, // anniversary month (default Jan)
		FL: 4, // May
		TX: 4, // May
		CA: 3, // April (Statement of Information)
		NY: 1, // biennial, February
		NV: 0, // anniversary month
	};
	return monthMap[state] ?? 0; // Default to January
}

// ── Queries ──────────────────────────────────────────────────────────────────

export function getFormationStatus(entityId: string): BusinessEntity | undefined {
	return entityStore.get(entityId);
}

export function listOrgEntities(orgId: OrgId): BusinessEntity[] {
	return [...entityStore.values()].filter((e) => e.orgId === orgId);
}

export function getEntityComplianceEvents(entityId: string): ComplianceEvent[] {
	const entity = entityStore.get(entityId);
	return entity?.complianceCalendar ?? [];
}

export function getUpcomingCompliance(orgId: OrgId, daysAhead: number = 30): ComplianceEvent[] {
	const cutoff = new Date(Date.now() + daysAhead * 86_400_000);
	const entities = listOrgEntities(orgId);
	return entities
		.flatMap((e) => e.complianceCalendar)
		.filter((c) => c.dueDate <= cutoff && c.status !== "completed")
		.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

// ── Cost Estimation ──────────────────────────────────────────────────────────

export function estimateFormationCost(
	entityType: EntityType,
	state: USState,
	options: { registeredAgent: boolean; bankAccount: boolean; einApplication: boolean },
): {
	serviceFee: number;
	stateFilingFee: number;
	registeredAgentFee: number;
	totalCents: number;
	breakdown: string[];
} {
	const serviceFee = FORMATION_SERVICE_FEE_CENTS[entityType];
	const stateFees = STATE_FILING_FEES[state];
	const stateFilingFee = (stateFees?.[entityType] ?? 150) * 100; // convert to cents
	const registeredAgentFee = options.registeredAgent ? REGISTERED_AGENT_ANNUAL_FEE_CENTS : 0;

	const totalCents = serviceFee + stateFilingFee + registeredAgentFee;

	const breakdown: string[] = [
		`Formation service fee: $${(serviceFee / 100).toFixed(2)}`,
		`${state} state filing fee: $${(stateFilingFee / 100).toFixed(2)}`,
	];
	if (options.registeredAgent) {
		breakdown.push(`Registered agent (annual): $${(registeredAgentFee / 100).toFixed(2)}`);
	}
	if (options.einApplication) {
		breakdown.push("EIN application: $0.00 (included)");
	}
	breakdown.push(`**Total: $${(totalCents / 100).toFixed(2)}**`);

	return { serviceFee, stateFilingFee, registeredAgentFee, totalCents, breakdown };
}
