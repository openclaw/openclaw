// Plugin SDK facade: generic outbound delivery-report seam.
//
// Channel plugins that deliver outbound messages through their own provider path
// (rather than core's central outbound delivery path) call `reportOutboundDelivered` so
// the canonical `message.sent` event still fires for those sends.
//
// This facade intentionally exposes ONLY the delivery-report contract. It does
// NOT re-export `emitMessageSent`, `createInternalHookEvent`, the hook runner, or
// any other raw hook-emission primitive — extensions report a delivery; core owns
// turning that into a canonical event.
export {
  reportOutboundDelivered,
  type OutboundDeliveryReport,
} from "../infra/outbound/report-outbound-delivered.js";
