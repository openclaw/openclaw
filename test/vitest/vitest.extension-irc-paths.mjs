export const ircExtensionTestRoots = ["extensions/irc"];

export function isIrcExtensionRoot(root) {
  return ircExtensionTestRoots.includes(root);
}
