import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/index.ts";
import { enrollGatewayProfile } from "../../api/gateway-profile-enrollment.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { persistSessionToken } from "../../app/settings.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { generateUUID } from "../../lib/uuid.ts";

/** A device attachment is a Profile operation; Gateway identity remains authoritative. */
export class PersonalEnrollmentState {
  name = "";
  profileId = "";
  busy = false;
  error: string | null = null;
  success = false;
  private admission: {
    profileId: string;
    client: ApplicationGateway["snapshot"]["client"];
    hello: ApplicationGateway["snapshot"]["hello"];
  } | null = null;
  private enrollmentId: string | undefined;
  private client;
  private hello;
  private gatewayUrl: string;
  private generation = 0;

  constructor(
    readonly gateway: ApplicationGateway,
    readonly publish: () => void,
    readonly deviceId?: string,
  ) {
    this.client = gateway.snapshot.client;
    this.hello = gateway.snapshot.hello;
    this.gatewayUrl = gateway.connection.gatewayUrl;
  }

  get canEnroll() {
    const snapshot = this.gateway.snapshot;
    const enrollment = snapshot.client?.profileEnrollment;
    return (
      canCallGatewayMethod(snapshot, "device.profile.enroll", "operator.admin", {
        requireAdvertisement: false,
      }) && Boolean(enrollment?.deviceId || enrollment?.native?.enrollProfile)
    );
  }

  get personal() {
    const user = this.gateway.snapshot.selfUser;
    return Boolean(user && user.id !== GATEWAY_OWNER_PROFILE_ID);
  }

  get expectedProfileId() {
    return this.admission?.profileId ?? null;
  }

  get reconnecting() {
    return this.admission !== null && !this.success && this.error === null;
  }

  private reconcileAdmission() {
    const admission = this.admission;
    if (!admission) {
      return;
    }
    const snapshot = this.gateway.snapshot;
    const replacement = snapshot.client !== admission.client || snapshot.hello !== admission.hello;
    this.success = false;
    if (snapshot.phase === "connected" && replacement && snapshot.selfUser !== undefined) {
      this.success = snapshot.selfUser?.id === admission.profileId;
      this.error = this.success ? null : t("profilePage.enrollment.conflict");
      this.busy = false;
    } else if (
      snapshot.phase === "offline" ||
      snapshot.phase === "stopped" ||
      snapshot.phase === "reload-required"
    ) {
      this.error = t(
        snapshot.lastErrorCode === "FORBIDDEN"
          ? "profilePage.enrollment.restricted"
          : "profilePage.enrollment.failed",
        { detail: snapshot.lastError ?? t("profilePage.enrollment.reconnect") },
      );
      this.busy = false;
    } else {
      this.error = null;
      this.busy = true;
    }
  }

  sync() {
    const snapshot = this.gateway.snapshot;
    if (this.gatewayUrl !== this.gateway.connection.gatewayUrl) {
      this.generation++;
      this.enrollmentId = undefined;
      this.profileId = "";
      this.name = "";
      this.error = null;
      this.success = false;
      this.admission = null;
      this.busy = false;
    } else if (
      this.client !== snapshot.client ||
      this.hello !== snapshot.hello ||
      snapshot.phase !== "connected"
    ) {
      this.generation++;
      if (this.busy && !this.admission) {
        this.error = t("profilePage.enrollment.connectionChanged");
      }
      if (!this.admission) {
        this.busy = false;
      }
    }
    this.client = snapshot.client;
    this.hello = snapshot.hello;
    this.gatewayUrl = this.gateway.connection.gatewayUrl;
    this.reconcileAdmission();
    this.publish();
  }

  dispose() {
    this.generation++;
  }

  async enroll() {
    const client = this.gateway.snapshot.client;
    if (!client || !this.canEnroll || this.busy || this.success || this.admission) {
      return;
    }
    const generation = this.generation;
    const hello = this.gateway.snapshot.hello;
    const selfDeviceId = client.profileEnrollment?.deviceId;
    this.busy = true;
    this.error = null;
    this.publish();
    try {
      // The same UUID survives failures and reconnects; retry cannot create another person.
      if (!this.profileId) {
        this.enrollmentId ??= generateUUID();
      }
      const result = await enrollGatewayProfile(client, {
        ...(this.deviceId ? { deviceId: this.deviceId } : {}),
        ...(this.profileId
          ? { profileId: this.profileId }
          : {
              enrollmentId: this.enrollmentId,
              ...(this.name.trim() ? { name: this.name.trim() } : {}),
            }),
      });
      // The default target is self; the app owner also records self-grant rotation in its receipt.
      const self = !this.deviceId || result.reconnect || result.deviceId === selfDeviceId;
      if (generation === this.generation) {
        if (self) {
          // A committed attachment is not proof that its replacement sign-in was admitted.
          this.admission = { profileId: result.profileId, client, hello };
          this.reconcileAdmission();
        } else {
          this.success = true;
        }
        this.publish();
      }
      // Credential settlement outlives dismissal; only the exact live connection may reconnect.
      if (self && this.gateway.snapshot.client === client && this.canEnroll) {
        if (result.reconnect) {
          persistSessionToken(this.gateway.connection.gatewayUrl, "");
          this.gateway.connect({ token: "", password: "", bootstrapToken: "" });
        } else {
          this.gateway.connect();
        }
      }
    } catch (error) {
      if (generation === this.generation) {
        const code = error instanceof GatewayRequestError ? error.code : undefined;
        this.error = t(
          code === "FORBIDDEN"
            ? "profilePage.enrollment.restricted"
            : code === "CONFLICT"
              ? "profilePage.enrollment.conflict"
              : "profilePage.enrollment.failed",
          { detail: formatUiError(error) },
        );
      }
    } finally {
      if (generation === this.generation) {
        this.busy = this.reconnecting;
        this.publish();
      }
    }
  }
}
