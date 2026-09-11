// Node-local publication consent for live local sessions. Offers arrive from the
// Gateway over the source duplex; the person confirms them with the local CLI.
// Lives in the shared state DB so the node-host service and the CLI share it.
import { z } from "zod";
import type { LocalSessionEnrollmentSummary } from "../sessions/local-session-source-protocol.js";
import { updateConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";

const LOCAL_SESSION_CONSENT_STATE_KEY = "nodeHost.localSessions";
/** Offers the person never answered expire so a stale request cannot be confirmed later. */
const OFFER_TTL_MS = 24 * 60 * 60 * 1000;

const enrollmentSummarySchema = z
  .object({
    enrollmentId: z.string().min(1),
    agentId: z.string().min(1),
    requester: z.object({ profileId: z.string().min(1), displayName: z.string().min(1) }),
    audienceLabel: z.string().min(1),
    setupId: z.string().min(1).optional(),
  })
  .strict();

const offerSchema = z
  .object({
    sourceId: z.string().min(1),
    enrollment: enrollmentSummarySchema,
    receivedAtMs: z.number().int().nonnegative(),
  })
  .strict();

const consentSchema = z
  .object({
    sourceId: z.string().min(1),
    enrollment: enrollmentSummarySchema,
    decision: z.enum(["accepted", "declined"]),
    decidedAtMs: z.number().int().nonnegative(),
    /** Set once the node host delivered the decision to the Gateway. */
    deliveredAtMs: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * `openclaw connect --share <source>`: the person already said yes on this
 * machine, so the first offer for that source is accepted without a prompt.
 */
const gatewayOriginSchema = z
  .object({ host: z.string().min(1), port: z.number().int().positive(), contextPath: z.string() })
  .strict();

const preconsentSchema = z
  .object({
    sourceId: z.string().min(1),
    /** The Gateway `openclaw connect` paired with; an offer from any other Gateway still prompts. */
    gateway: gatewayOriginSchema,
    /** The pairing setup the minted command names; only that setup's enrollment is accepted. */
    setupId: z.string().min(1),
    decidedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
  })
  .strict();

const stateSchema = z
  .object({
    version: z.literal(1),
    offers: z.array(offerSchema),
    consents: z.array(consentSchema),
    preconsents: z.array(preconsentSchema).optional(),
  })
  .strict();

export type LocalSessionConsent = z.infer<typeof consentSchema>;
export type LocalSessionPreconsent = z.infer<typeof preconsentSchema>;
export type LocalSessionGatewayOrigin = z.infer<typeof gatewayOriginSchema>;
type LocalSessionConsentState = z.infer<typeof stateSchema> & {
  preconsents: LocalSessionPreconsent[];
};

function normalizeState(raw: unknown, now: number): LocalSessionConsentState {
  const parsed = stateSchema.safeParse(raw);
  const state = parsed.success ? parsed.data : { version: 1 as const, offers: [], consents: [] };
  return {
    ...state,
    offers: state.offers.filter((offer) => now - offer.receivedAtMs < OFFER_TTL_MS),
    preconsents: (state.preconsents ?? []).filter((entry) => entry.expiresAtMs > now),
  };
}

/** Consent given up front on this machine; consumed by the first matching offer. */
export function recordLocalSessionPreconsent(
  params: { sourceId: string; gateway: LocalSessionGatewayOrigin; setupId: string },
  options: OpenClawStateDatabaseOptions = {},
): LocalSessionPreconsent {
  const now = Date.now();
  const { sourceId, gateway, setupId } = params;
  const preconsent = {
    sourceId,
    gateway,
    setupId,
    decidedAtMs: now,
    expiresAtMs: now + OFFER_TTL_MS,
  };
  updateConfigMachineState<LocalSessionConsentState>(
    LOCAL_SESSION_CONSENT_STATE_KEY,
    (current) => {
      const state = normalizeState(current, now);
      return {
        ...state,
        preconsents: [
          ...state.preconsents.filter((entry) => entry.sourceId !== sourceId),
          preconsent,
        ],
      };
    },
    options,
  );
  return preconsent;
}

export function readLocalSessionConsentState(
  options: OpenClawStateDatabaseOptions = {},
): LocalSessionConsentState {
  return normalizeState(
    readConfigMachineState(LOCAL_SESSION_CONSENT_STATE_KEY, options),
    Date.now(),
  );
}

/**
 * Record a Gateway offer; repeated offers for one enrollment refresh the row. An
 * offer covered by a pre-consent is accepted on the spot (the pre-consent is
 * spent) and reported so the runtime can finish source-side enablement.
 */
export function recordLocalSessionOffer(
  params: {
    sourceId: string;
    enrollment: LocalSessionEnrollmentSummary;
    /** The Gateway this offer arrived from; absent means no pre-consent can apply. */
    gateway?: LocalSessionGatewayOrigin;
  },
  options: OpenClawStateDatabaseOptions = {},
): { autoAccepted: boolean } {
  const now = Date.now();
  let autoAccepted = false;
  updateConfigMachineState<LocalSessionConsentState>(
    LOCAL_SESSION_CONSENT_STATE_KEY,
    (current) => {
      const state = normalizeState(current, now);
      const alreadyDecided = state.consents.some(
        (consent) => consent.enrollment.enrollmentId === params.enrollment.enrollmentId,
      );
      if (alreadyDecided) {
        return state;
      }
      const offers = state.offers.filter(
        (offer) => offer.enrollment.enrollmentId !== params.enrollment.enrollmentId,
      );
      const origin = params.gateway;
      const offeredSetup = params.enrollment.setupId;
      // The person consented to one minted request: same source, same Gateway,
      // and the setup that request named. Anything else is an ordinary prompt.
      const preconsent =
        origin && offeredSetup
          ? state.preconsents.find(
              (entry) =>
                entry.sourceId === params.sourceId &&
                entry.setupId === offeredSetup &&
                entry.gateway.host === origin.host &&
                entry.gateway.port === origin.port &&
                entry.gateway.contextPath === origin.contextPath,
            )
          : undefined;
      if (preconsent) {
        autoAccepted = true;
        return {
          ...state,
          offers,
          preconsents: state.preconsents.filter((entry) => entry !== preconsent),
          consents: [
            ...state.consents,
            {
              sourceId: params.sourceId,
              enrollment: params.enrollment,
              decision: "accepted",
              decidedAtMs: now,
            },
          ],
        };
      }
      return {
        ...state,
        offers: [
          ...offers,
          { sourceId: params.sourceId, enrollment: params.enrollment, receivedAtMs: now },
        ],
      };
    },
    options,
  );
  return { autoAccepted };
}

/** The person's decision, taken by the local CLI. Moves the offer into consents. */
export function decideLocalSessionOffer(
  params: { enrollmentId: string; decision: "accepted" | "declined" },
  options: OpenClawStateDatabaseOptions = {},
): LocalSessionConsent | undefined {
  const now = Date.now();
  let decided: LocalSessionConsent | undefined;
  updateConfigMachineState<LocalSessionConsentState>(
    LOCAL_SESSION_CONSENT_STATE_KEY,
    (current) => {
      const state = normalizeState(current, now);
      const offer = state.offers.find(
        (candidate) => candidate.enrollment.enrollmentId === params.enrollmentId,
      );
      if (!offer) {
        return state;
      }
      decided = {
        sourceId: offer.sourceId,
        enrollment: offer.enrollment,
        decision: params.decision,
        decidedAtMs: now,
      };
      return {
        ...state,
        offers: state.offers.filter((candidate) => candidate !== offer),
        consents: [
          ...state.consents.filter(
            (consent) => consent.enrollment.enrollmentId !== params.enrollmentId,
          ),
          decided,
        ],
      };
    },
    options,
  );
  return decided;
}

export function markLocalSessionConsentDelivered(
  enrollmentId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const now = Date.now();
  updateConfigMachineState<LocalSessionConsentState>(
    LOCAL_SESSION_CONSENT_STATE_KEY,
    (current) => {
      const state = normalizeState(current, now);
      const consents = [...state.consents];
      const index = consents.findIndex(
        (consent) => consent.enrollment.enrollmentId === enrollmentId,
      );
      const delivered = consents[index];
      if (delivered) {
        consents[index] = { ...delivered, deliveredAtMs: now };
      }
      return { ...state, consents };
    },
    options,
  );
}

/** Drop a consent the Gateway revoked so a re-enrollment gets a fresh decision. */
export function forgetLocalSessionConsent(
  enrollmentId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const now = Date.now();
  updateConfigMachineState<LocalSessionConsentState>(
    LOCAL_SESSION_CONSENT_STATE_KEY,
    (current) => {
      const state = normalizeState(current, now);
      return {
        ...state,
        offers: state.offers.filter((offer) => offer.enrollment.enrollmentId !== enrollmentId),
        consents: state.consents.filter(
          (consent) => consent.enrollment.enrollmentId !== enrollmentId,
        ),
      };
    },
    options,
  );
}
