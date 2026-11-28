// Both frozen launcher formats use these same junction switch and interruption semantics.
export const LINK_SOURCE = String.raw`
function switchLink(target) {
  const temporary = path.join(prefix, ".openclaw.release-link-" + process.pid + "-" + Date.now());
  const old = fs.lstatSync(slot, { throwIfNoEntry: false }) ? fs.readlinkSync(slot) : null;
  fs.symlinkSync(linked(target), temporary, "junction");
  if (process.platform === "win32") fs.rmSync(slot, { force: true });
  fs.renameSync(temporary, slot);
  // As the store switch does, count retention age from deselection, not prepare.
  if (old) {
    let release = linked(old);
    while (path.dirname(release) !== release && path.dirname(release) !== path.join(prefix, "releases")) release = path.dirname(release);
    if (path.dirname(release) === path.join(prefix, "releases")) {
      try { const now = new Date(); fs.utimesSync(release, now, now); } catch {}
    }
  }
}
function finishSwitch() {
  if (fs.lstatSync(slot, { throwIfNoEntry: false })) return;
  const waiting = fs.readdirSync(prefix).filter((name) => name.startsWith(".openclaw.release-link-"))
    .map((name) => path.join(prefix, name))
    .sort((a, b) => fs.lstatSync(b).mtimeMs - fs.lstatSync(a).mtimeMs)[0];
  if (waiting) fs.renameSync(waiting, slot);
}
`;
