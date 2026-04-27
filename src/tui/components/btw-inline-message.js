import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
export class BtwInlineMessage extends Container {
    constructor(params) {
        super();
        this.setResult(params);
    }
    setResult(params) {
        this.clear();
        this.addChild(new Spacer(1));
        this.addChild(new Text(theme.header(`BTW: ${params.question}`), 1, 0));
        if (params.isError) {
            this.addChild(new Text(theme.error(params.text), 1, 0));
        }
        else {
            this.addChild(new AssistantMessageComponent(params.text));
        }
        this.addChild(new Text(theme.dim("Press Enter or Esc to dismiss"), 1, 0));
    }
}
