import { asRecord } from "./record-coerce.js";
export function parsePairingList(value) {
    const obj = asRecord(value);
    const pending = Array.isArray(obj.pending) ? obj.pending : [];
    const paired = Array.isArray(obj.paired) ? obj.paired : [];
    return { pending, paired };
}
export function parseNodeList(value) {
    const obj = asRecord(value);
    return Array.isArray(obj.nodes) ? obj.nodes : [];
}
