import { createContext, type Accessor } from "solid-js";
import type { ChatRowDisplay } from "../../../lib/chat/row-display-facts.ts";

export const ChatRowDisplayContext = createContext<Accessor<ChatRowDisplay | undefined> | null>(
  null,
);
