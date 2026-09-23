import ctypes as c, json, os, runpy, subprocess, sys, time
from ctypes import wintypes as w
owner = runpy.run_path(sys.argv[1], run_name="settlement_test_owner")
job_members = owner["job_members"]
g = job_members.__globals__
assign = g["bind"]("AssignProcessToJobObject", w.BOOL, w.HANDLE, w.HANDLE)
original_query = g["query_job"]
children = []
def process():
    child = subprocess.Popen([sys.executable, "-I", "-S", "-c", "import time; time.sleep(60)"])
    children.append(child)
    return child
results=[]
for fault in ["reused-pid", "member-race", "termination-race"]:
    job = g["create_job"](None, None)
    limits = g["ExtendedLimits"]()
    limits.BasicLimitInformation.LimitFlags = 0x2000
    g["set_job"](job,9,c.byref(limits),c.sizeof(limits))
    sentinel=process()
    member=process();assign(job,int(member._handle))
    calls=0
    racing=None
    def query(j, kind, data, size, written):
        global calls, racing
        result=original_query(j,kind,data,size,written)
        if kind==3 and fault=="reused-pid":
            # Discovery returns an unrelated birth. Membership on the opened
            # immutable handle must reject it without touching the sentinel.
            c.cast(data,c.POINTER(c.c_size_t))[1]=sentinel.pid
        if kind==1:
            calls+=1
            if calls==2 and fault=="member-race":
                racing=process();assign(job,int(racing._handle))
                result=original_query(j,kind,data,size,written)
        return result
    g["query_job"]=query
    real_terminate=g["terminate_job"]
    def terminate(j, code):
        global racing
        if fault=="termination-race" and racing is None:
            racing=process();assign(job,int(racing._handle))
        return real_terminate(j,code)
    g["terminate_job"]=terminate
    started=time.monotonic();failure=None
    try:
        if fault=="termination-race":
            bootstrap=process()
            g["drain"](bootstrap,job)
        else:
            held,total=job_members(job,started+10)
            for handle in held:g["close_handle"](handle)
    except RuntimeError as error:failure=str(error)
    finally:
        g["query_job"]=original_query;g["terminate_job"]=real_terminate
        real_terminate(job,1)
        member.wait(timeout=10)
        if racing:racing.wait(timeout=10)
        alive=sentinel.poll() is None
        sentinel.kill();sentinel.wait(timeout=10)
        g["close_handle"](job)
    assert failure, fault
    assert alive, "unrelated sentinel was terminated"
    expected={"reused-pid":"identity changed", "member-race":"grew during census", "termination-race":"grew during cleanup"}[fault]
    assert expected in failure,(fault,failure)
    assert time.monotonic()-started<10
    results.append(dict(fault=fault,failure=failure,sentinelPreserved=alive,elapsed=time.monotonic()-started))
assert all(child.poll() is not None for child in children)
print(json.dumps(results))
