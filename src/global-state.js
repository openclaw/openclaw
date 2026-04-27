let globalVerbose = false;
let globalYes = false;
export function setVerbose(v) {
    globalVerbose = v;
}
export function isVerbose() {
    return globalVerbose;
}
export function setYes(v) {
    globalYes = v;
}
export function isYes() {
    return globalYes;
}
