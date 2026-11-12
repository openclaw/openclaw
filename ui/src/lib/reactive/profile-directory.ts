import type { ApplicationGateway } from "../../app/gateway.ts";
import { profileDirectory } from "../profile-directory.ts";
import { projectSource } from "./projection.ts";

/** A person view explicitly retains self reads; avatar-only directory readers do not. */
export function projectProfileDirectory(gateway: ApplicationGateway) {
  return projectSource(profileDirectory(gateway), {
    read: (owner) => owner,
    subscribe: (owner, notify) => owner.subscribe(notify, true),
    equality: "revision",
  });
}
