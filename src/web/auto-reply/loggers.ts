import { createSubsystemLogger } from "../../logging/subsystem.js";

export const whatsappLog = createSubsystemLogger("gateway/channels/whatsapp");
export const whatsappInboundLog = whatsappLog.child("inbound");
export const whatsappOutboundLog = whatsappLog.child("outbound");
export const whatsappHeartbeatLog = whatsappLog.child("heartbeat");
