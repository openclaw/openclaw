import type { createFleetService } from "../../fleet/service.runtime.js";

type LocalFleetService = ReturnType<typeof createFleetService>;

/**
 * Lifecycle surface consumed by Fleet commands for one selected execution target.
 *
 * This is an in-process adapter contract, not a transport schema. A remote target
 * must translate these command inputs into a separately validated, bounded wire
 * protocol rather than forwarding secrets, environment entries, or host paths.
 */
export interface FleetCommandTarget {
  create: LocalFleetService["create"];
  list: LocalFleetService["list"];
  status: LocalFleetService["status"];
  logs: LocalFleetService["logs"];
  lifecycle: LocalFleetService["lifecycle"];
  upgrade: LocalFleetService["upgrade"];
  backup: LocalFleetService["backup"];
  restore: LocalFleetService["restore"];
  doctor: LocalFleetService["doctor"];
  remove: LocalFleetService["remove"];
}
