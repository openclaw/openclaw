// Devices page owner for live local session sharing: source descriptors,
// enrollment rows, and the enroll/revoke actions. Rows change only through
// Gateway responses and sessions.local.enrollment events, so one load per
// connection plus event merges keeps them current without polling.
import { initialState, Task } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { LocalSessionEnrollment } from "../../../../packages/gateway-protocol/src/schema/sessions-local.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import type {
  LocalSessionSharingProps,
  LocalSessionSourceDescriptor,
} from "./view-local-sessions.ts";

type DevicesPageLink = {
  gateway: Pick<GatewayPageController, "gateway" | "client" | "connected">;
  /** Advances on reconnect or provider replacement; stale responses must not land. */
  requestGeneration: number;
};

type TaskArgs = readonly [unknown, GatewayBrowserClient | null];

// Not a ReactiveController itself: the two Tasks register with the host and
// drive re-renders; explicit lifecycle comes from the page (reset, events).
export class LocalSessionSharingController {
  private sources: LocalSessionSourceDescriptor[] = [];
  private enrollments: LocalSessionEnrollment[] = [];
  private agentByDevice: Record<string, string> = {};
  private busyKey: string | null = null;
  private error: LocalSessionSharingProps["error"] = null;
  private readonly sourcesTask: Task<TaskArgs, { sources: LocalSessionSourceDescriptor[] }>;
  private readonly enrollmentsTask: Task<TaskArgs, { enrollments: LocalSessionEnrollment[] }>;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly link: () => DevicesPageLink,
  ) {
    this.sourcesTask = new Task(host, {
      args: () => this.taskArgs(),
      task: ([gateway, client], { signal }) =>
        gateway && client
          ? client.request<{ sources: LocalSessionSourceDescriptor[] }>(
              "sessions.local.sources",
              {},
              { signal },
            )
          : initialState,
      onComplete: (result) => {
        this.sources = result.sources;
      },
      onError: () => {
        this.sources = [];
      },
    });
    this.enrollmentsTask = new Task(host, {
      args: () => this.taskArgs(),
      task: ([gateway, client], { signal }) =>
        gateway && client
          ? client.request<{ enrollments: LocalSessionEnrollment[] }>(
              "sessions.local.enrollments",
              {},
              { signal },
            )
          : initialState,
      onComplete: (result) => {
        this.enrollments = result.enrollments;
      },
      onError: () => {
        this.enrollments = [];
      },
    });
  }

  private taskArgs(): TaskArgs {
    const { gateway } = this.link();
    return [gateway.gateway, gateway.connected ? gateway.client : null];
  }

  /** Retire in-flight responses and rows; the next connected update reloads them. */
  reset(): void {
    void this.sourcesTask.run([null, null]);
    void this.enrollmentsTask.run([null, null]);
    this.sources = [];
    this.enrollments = [];
    this.busyKey = null;
    this.error = null;
  }

  handleGatewayEvent(event: { event: string; payload?: unknown }): void {
    if (event.event === "sessions.local.enrollment") {
      this.mergeEnrollment(event.payload);
    }
  }

  private mergeEnrollment(payload: unknown) {
    // SAFETY: sessions.local.enrollment payloads carry an `enrollment` object per the Gateway schema.
    const enrollment = (payload as { enrollment?: LocalSessionEnrollment } | null)?.enrollment;
    if (!enrollment?.enrollmentId) {
      return;
    }
    this.enrollments = [
      ...this.enrollments.filter((row) => row.enrollmentId !== enrollment.enrollmentId),
      enrollment,
    ];
    this.host.requestUpdate();
  }

  // Both mutations answer with the enrollment row; merging it here makes the
  // outcome visible even when the broadcast reaches this client later.
  private async runAction(
    busyKey: string,
    deviceId: string,
    request: (client: GatewayBrowserClient) => Promise<{ enrollment?: LocalSessionEnrollment }>,
  ) {
    const { gateway, requestGeneration } = this.link();
    const client = gateway.client;
    if (this.busyKey !== null || !client || !gateway.connected) {
      return;
    }
    this.busyKey = busyKey;
    this.error = null;
    this.host.requestUpdate();
    try {
      const result = await request(client);
      if (requestGeneration === this.link().requestGeneration) {
        this.mergeEnrollment(result);
      }
    } catch (error) {
      if (requestGeneration === this.link().requestGeneration) {
        this.error = { deviceId, message: formatUiError(error) };
      }
    } finally {
      if (this.busyKey === busyKey) {
        this.busyKey = null;
      }
      this.host.requestUpdate();
    }
  }

  props(snapshot: ApplicationGatewaySnapshot): LocalSessionSharingProps {
    const connected = snapshot.phase === "connected";
    const auth = snapshot.hello?.auth ?? null;
    const identity = snapshot.selfUser?.identity;
    const canWrite = connected && hasOperatorWriteAccess(auth);
    return {
      sources: this.sources,
      enrollments: this.enrollments,
      selfProfileId: identity?.type === "profile" ? identity.id : null,
      canWrite,
      canAdmin: connected && hasOperatorAdminAccess(auth),
      selectedAgentByDevice: this.agentByDevice,
      busyKey: this.busyKey,
      error: this.error,
      onSelectAgent: (deviceId, agentId) => {
        this.agentByDevice = { ...this.agentByDevice, [deviceId]: agentId };
        this.host.requestUpdate();
      },
      onShare: (deviceId, sourceId, agentId) => {
        if (canWrite) {
          void this.runAction(`${deviceId}:${sourceId}`, deviceId, (client) =>
            client.request("sessions.local.enroll", { deviceId, sourceId, agentId }),
          );
        }
      },
      onStopSharing: (enrollmentId) => {
        const enrollment = this.enrollments.find((row) => row.enrollmentId === enrollmentId);
        if (canWrite && enrollment) {
          void this.runAction(enrollmentId, enrollment.deviceId, (client) =>
            client.request("sessions.local.revoke", { enrollmentId }),
          );
        }
      },
    };
  }
}
