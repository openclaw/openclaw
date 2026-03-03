export function logInboundDrop(params) {
    const target = params.target ? ` target=${params.target}` : "";
    params.log(`${params.channel}: drop ${params.reason}${target}`);
}
export function logTypingFailure(params) {
    const target = params.target ? ` target=${params.target}` : "";
    const action = params.action ? ` action=${params.action}` : "";
    params.log(`${params.channel} typing${action} failed${target}: ${String(params.error)}`);
}
export function logAckFailure(params) {
    const target = params.target ? ` target=${params.target}` : "";
    params.log(`${params.channel} ack cleanup failed${target}: ${String(params.error)}`);
}
