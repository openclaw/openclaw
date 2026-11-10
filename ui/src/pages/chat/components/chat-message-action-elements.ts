export type MessageActionElements = {
  copy?: HTMLButtonElement;
  readAloud?: HTMLButtonElement;
};

type ActionOwner = {
  messageKey: () => string | undefined;
  elements: MessageActionElements;
};

const groupActions = new WeakMap<Element, Map<HTMLElement, ActionOwner>>();

export function registerMessageActionElements(
  element: HTMLElement,
  messageKey: () => string | undefined,
  elements: MessageActionElements,
): () => void {
  const group = element.closest(".chat-group");
  if (!group) {
    return () => {};
  }
  let owners = groupActions.get(group);
  if (!owners) {
    owners = new Map();
    groupActions.set(group, owners);
  }
  owners.set(element, { messageKey, elements });
  return () => {
    owners.delete(element);
    if (owners.size === 0) {
      groupActions.delete(group);
    }
  };
}

export function getMessageActionElements(
  group: Element,
  messageKey: string,
): MessageActionElements | undefined {
  for (const [element, owner] of groupActions.get(group) ?? []) {
    if (element.isConnected && owner.messageKey() === messageKey) {
      return {
        copy: owner.elements.copy?.isConnected ? owner.elements.copy : undefined,
        readAloud: owner.elements.readAloud?.isConnected ? owner.elements.readAloud : undefined,
      };
    }
  }
  return undefined;
}
