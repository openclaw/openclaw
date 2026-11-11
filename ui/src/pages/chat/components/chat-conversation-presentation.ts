import { createContext, type Accessor } from "solid-js";

/** The pane supplies merged chrome; a narrow desktop panel is still desktop. */
export const ChatConversationMobile = createContext<Accessor<boolean>>(() => false);
