/**
 * Create a message action (sends text when tapped)
 */
export function messageAction(label, text) {
    return {
        type: "message",
        label: label.slice(0, 20),
        text: text ?? label,
    };
}
/**
 * Create a URI action (opens a URL when tapped)
 */
export function uriAction(label, uri) {
    return {
        type: "uri",
        label: label.slice(0, 20),
        uri,
    };
}
/**
 * Create a postback action (sends data to webhook when tapped)
 */
export function postbackAction(label, data, displayText) {
    return {
        type: "postback",
        label: label.slice(0, 20),
        data: data.slice(0, 300),
        displayText: displayText?.slice(0, 300),
    };
}
/**
 * Create a datetime picker action
 */
export function datetimePickerAction(label, data, mode, options) {
    return {
        type: "datetimepicker",
        label: label.slice(0, 20),
        data: data.slice(0, 300),
        mode,
        initial: options?.initial,
        max: options?.max,
        min: options?.min,
    };
}
